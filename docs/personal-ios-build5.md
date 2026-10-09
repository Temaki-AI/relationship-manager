# Everclose personal iOS build 5 — signed release, 5 October 2026

Build 5 contains native schema 15 and an optional reviewed Gmail metadata cache.
It retains the existing Today, People, profiles, contact photos, notes, interactions,
plans, reminders, iPhone Contacts and Calendar features. Frozen CRM sync version-4
requests and the existing account caches remain compatible with the hosted service.
The additive schema-14 upgrade preserves contacts, cursors, private drafts and
unconfirmed request bytes in the migration test.

Email metadata storage starts off. Account & sync can enable it or clear and disable
it. Per-person cards use a separate owner/device read-only endpoint; no grant,
mailbox download or provider-management action runs from this transport. Identity,
account, consent, dataset epoch and device-session changes invalidate the cache.
Offline display expires after at most 24 hours. Subjects require the retained web
choice. The cache is bounded to 500 messages, 64 profiles and 4 MiB; email observations
do not mark a person as contacted.

## Validation and delivery

All 868 root tests, 15 focused D1/mobile SQLite transport tests, eight desktop/mobile
profile/Calendar journeys, root/native TypeScript and lint, five native package
tests, production Hermes export and standalone/Cloudflare builds pass.

Both native Release builds, linkage verification and isolated simulator
SQLite/Keychain startup pass in
[run 37306709947](https://github.com/Temaki-AI/relationship-manager/actions/runs/37306709947).
The downloaded device artifact checksum and exact native/domain/configuration
tree match were verified. The first-launch screenshot was inspected and shows
the Google sign-in welcome screen. Local signing and strict signature verification
pass; the private key stays on this Mac.

The private package is `apps/mobile/build/releases/Everclose-1.0.0-ios-build5.ipa`,
SHA-256 `571039b2d6d66363b962d23964017b46eda3cf5e659db24da92ff47be1422554`.
Native and JavaScript source are `87eb24831f1930f2c02c0ee662cd78f4d82bde01`;
the compiled CI merge is `136519eb1a4981a5aaa81df15da3efb6db53b521`.
Xcode is 26.4.1, version is 1.0.0, build is 5 and minimum iOS is 16.4.

Installation could not start because CoreDevice could not find the phone
(error 1011). The failed receipt/log are preserved in the ignored
`build5-installation` directory. The owner has been asked to reconnect the iPhone
by USB and unlock it. After the owner reported unlocking, a second targeted
installation still returned error 1011. Cached connection details showed no tunnel
and the same last connection; direct USB reconnection/Trust confirmation is pending.
Both failed receipts are preserved. There is no build-5 installation or physical UI/data result
yet. Build 4 is the last verified installation; its launch/process checks are recorded in
[the build-4 release record](personal-ios-build4.md).

Cloud CI validation passes for this source in
[run 37306709882](https://github.com/Temaki-AI/relationship-manager/actions/runs/37306709882).
Its general validation job passed the root tests and was cancelled during the
full D1 step; it is not reported as green. Historical dependency-audit failures
remain open and are not bypassed by the personal iOS package.

The default server is https://everclosecrm.com. Production was last verified at
migration 44, and Gmail requires migrations 45–47 plus a matching source deployment.
These changes have not been deployed. Enabling email storage against the existing
server reports that email context is unavailable and does not prevent CRM sync.
Dedicated Google OAuth clients/vault and a controlled real-account pilot remain
required for complete provider integrations. A later server/web change implements
default-off recurring Gmail reconciliation and requires migration 48; it does not
replace this signed package or establish production delivery. Reviewed activity
behavior and TestFlight/App Store distribution remain open.

Signing keys stay on this Mac. Signed packages, provisioning material and phone
verification receipts belong in the ignored private release directory.
