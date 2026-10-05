#!/usr/bin/env python3
"""Verify an isolated GitHub runner's simulator; never use the shared local Simulator."""
import argparse
import os
from pathlib import Path
import re
import subprocess
import sys
import time

UUID_PATTERN = r'[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}'


def command(label, args, timeout, capture=False):
    print(label, file=sys.stderr, flush=True)
    return subprocess.run(args, check=True, timeout=timeout, text=True, capture_output=capture)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=['prepare', 'verify'])
    args = parser.parse_args()
    if os.environ.get('GITHUB_ACTIONS') != 'true':
        parser.error('This check only runs in its isolated GitHub Actions job.')
    if args.mode == 'prepare':
        device = command('Create isolated Everclose smoke device', ['xcrun', 'simctl', 'create',
            'Everclose-smoke', 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro',
            'com.apple.CoreSimulator.SimRuntime.iOS-26-4'], 60, True).stdout.strip()
        if not re.fullmatch(UUID_PATTERN, device):
            raise RuntimeError('Apple did not return a simulator identity.')
        command('Start first-boot migration before compilation', ['xcrun', 'simctl', 'boot', device], 60, True)
        print('EVERCLOSE_SMOKE_SIMULATOR=' + device)
        return
    device = os.environ.get('EVERCLOSE_SMOKE_SIMULATOR', '')
    if not re.fullmatch(UUID_PATTERN, device):
        raise RuntimeError('The prepared smoke simulator is missing.')
    app = Path('build/DerivedData/Build/Products/Release-iphonesimulator/Everclose.app')
    if not (app / 'main.jsbundle').is_file():
        raise RuntimeError('The compiled Everclose release app is missing.')
    schema = re.search(r'MOBILE_SCHEMA_VERSION\s*=\s*(\d+)', Path('src/data/schema.ts').read_text())
    if not schema:
        raise RuntimeError('The expected app schema could not be read.')
    command('Wait for isolated simulator boot', ['xcrun', 'simctl', 'bootstatus', device, '-b'], 600)
    command('Install compiled Everclose app', ['xcrun', 'simctl', 'install', device, str(app)], 120)
    command('Launch compiled Everclose app', ['xcrun', 'simctl', 'launch', device, 'com.fernandoamaral.bonds'], 60)
    container = command('Locate Everclose data container', ['xcrun', 'simctl', 'get_app_container',
        device, 'com.fernandoamaral.bonds', 'data'], 30, True).stdout.strip()
    database = Path(container) / 'Documents/SQLite/bonds-mobile.db'
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        if database.is_file():
            version = command('Wait for the app schema transaction', ['sqlite3', str(database),
                'PRAGMA user_version;'], 10, True).stdout.strip()
            if version != schema.group(1):
                time.sleep(1)
                continue
            result = command('Verify SQLite startup and Keychain installation marker', ['sqlite3', str(database),
                "PRAGMA user_version; SELECT count(*) FROM app_metadata WHERE key = 'device-source-installation'; "
                'PRAGMA integrity_check; SELECT count(*) FROM contacts;'], 10, True).stdout.strip().splitlines()
            if result == [schema.group(1), '1', 'ok', '0']:
                Path('build/artifact').mkdir(parents=True, exist_ok=True)
                command('Capture verified Everclose first launch', ['xcrun', 'simctl', 'io', device,
                    'screenshot', 'build/artifact/first-launch.png'], 30)
                print('Everclose startup, Keychain and SQLite verification passed.', file=sys.stderr)
                return
        time.sleep(1)
    raise RuntimeError('Everclose did not initialize its expected empty database and Keychain marker.')


if __name__ == '__main__':
    main()
