#!/usr/bin/env python3
"""Package an unsigned device app with an existing local Apple development identity.

No certificate/key is exported or uploaded. The resulting IPA is only installable on
devices already registered in the supplied development provisioning profile.
"""
import argparse
import datetime
import fnmatch
import hashlib
import pathlib
import plistlib
import re
import shutil
import subprocess
import tempfile


def run(*args):
    subprocess.run(args, check=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("app", type=pathlib.Path)
    parser.add_argument("--profile", required=True, type=pathlib.Path)
    parser.add_argument("--identity", required=True, help="SHA-1 fingerprint from security find-identity -v -p codesigning")
    parser.add_argument("--output", required=True, type=pathlib.Path)
    args = parser.parse_args()
    info = plistlib.loads((args.app / "Info.plist").read_bytes())
    if info.get("CFBundleIdentifier") != "com.fernandoamaral.bonds" or info.get("DTPlatformName") != "iphoneos":
        parser.error("Choose the Everclose device app, not the simulator app.")
    if args.output.exists():
        parser.error("The output already exists. Choose a new filename.")
    decoded = subprocess.run(["security", "cms", "-D", "-i", str(args.profile)], check=True, capture_output=True)
    profile = plistlib.loads(decoded.stdout)
    fingerprint = args.identity.upper()
    allowed_certificates = {hashlib.sha1(cert).hexdigest().upper() for cert in profile.get("DeveloperCertificates", [])}
    if not re.fullmatch(r"[0-9A-F]{40}", fingerprint) or fingerprint not in allowed_certificates:
        parser.error("The signing identity fingerprint must match a certificate in this profile.")
    identities = subprocess.run(["security", "find-identity", "-v", "-p", "codesigning"], check=True, capture_output=True, text=True)
    if fingerprint not in identities.stdout:
        parser.error("The profile's signing identity is not available in the local Keychain.")
    if not profile.get("ProvisionedDevices") or not profile.get("Entitlements", {}).get("get-task-allow"):
        parser.error("An existing development provisioning profile is required.")
    if profile["ExpirationDate"] <= datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None):
        parser.error("The provisioning profile has expired.")
    prefix = profile["ApplicationIdentifierPrefix"][0]
    app_id = f"{prefix}.{info['CFBundleIdentifier']}"
    if not fnmatch.fnmatchcase(app_id, profile["Entitlements"]["application-identifier"]):
        parser.error("The provisioning profile does not permit the Everclose bundle identifier.")
    entitlements = {
        "application-identifier": app_id,
        "com.apple.developer.team-identifier": profile["TeamIdentifier"][0],
        "keychain-access-groups": [app_id],
        "get-task-allow": True,
    }
    if not any(fnmatch.fnmatchcase(app_id, group) for group in profile["Entitlements"].get("keychain-access-groups", [])):
        parser.error("The profile does not permit the required Keychain access group.")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="everclose-sign-", dir=args.output.parent) as staging:
        root = pathlib.Path(staging)
        app = root / "Payload" / "Everclose.app"
        app.parent.mkdir()
        run("ditto", str(args.app), str(app))
        shutil.copyfile(args.profile, app / "embedded.mobileprovision")
        entitlements_path = root / "entitlements.plist"
        entitlements_path.write_bytes(plistlib.dumps(entitlements))
        # Every embedded framework is signed before sealing the containing app.
        for framework in sorted(app.rglob("*.framework"), key=lambda p: len(p.parts), reverse=True):
            run("codesign", "--force", "--sign", args.identity, "--timestamp=none", str(framework))
        run("codesign", "--force", "--sign", args.identity, "--timestamp=none",
            "--generate-entitlement-der", "--entitlements", str(entitlements_path), str(app))
        run("codesign", "--verify", "--deep", "--strict", "--verbose=2", str(app))
        run("ditto", "-c", "-k", "--sequesterRsrc", "--keepParent", str(app.parent), str(args.output))
    args.output.chmod(0o600)
    print(f"Signed development IPA: {args.output.resolve()}")
    print(f"Eligible devices: {len(profile['ProvisionedDevices'])}; profile expires {profile['ExpirationDate'].date()}.")


if __name__ == "__main__":
    main()
