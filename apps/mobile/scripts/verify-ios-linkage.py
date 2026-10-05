#!/usr/bin/env python3
"""Reject mismatched Expo Swift frameworks before distributing an iOS app."""
import argparse
from pathlib import Path
import plistlib
import subprocess


def symbols(binary, flags):
    output = subprocess.run(['nm', flags, str(binary)], check=True, text=True,
                            capture_output=True, timeout=30).stdout
    return {line.split()[-1] for line in output.splitlines() if line.split()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('app', type=Path)
    app = parser.parse_args().app
    info = plistlib.loads((app / 'Info.plist').read_bytes())
    if info.get('CFBundleIdentifier') != 'com.fernandoamaral.bonds':
        parser.error('Choose the compiled Everclose app.')
    frameworks = app / 'Frameworks'
    core = frameworks / 'ExpoModulesCore.framework/ExpoModulesCore'
    exports = symbols(core, '-gU') if core.is_file() else set()
    checked = 0
    for framework in frameworks.glob('*.framework'):
        binary = framework / framework.stem
        if not binary.is_file() or binary == core:
            continue
        required = {symbol for symbol in symbols(binary, '-u') if symbol.startswith('_$s15ExpoModulesCore')}
        if not required:
            continue
        missing = required - exports
        if missing:
            raise RuntimeError(f'{framework.name} requires missing ExpoModulesCore symbols: ' + ', '.join(sorted(missing)[:10]))
        checked += 1
    print(f'Expo native linkage verified ({checked} dynamic consumers; other modules may be statically linked).')


if __name__ == '__main__':
    main()
