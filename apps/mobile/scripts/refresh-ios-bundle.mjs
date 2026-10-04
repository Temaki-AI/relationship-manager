// Refresh JS-only changes in an already compiled native app. Native dependencies,
// config and Swift modules must still match the original native build commit.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const mobile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repository = path.resolve(mobile, '../..');
const [appArgument, nativeCommit] = process.argv.slice(2);
if (!appArgument || !nativeCommit) throw new Error('Usage: node scripts/refresh-ios-bundle.mjs APP_DIRECTORY NATIVE_BUILD_COMMIT');
const app = path.resolve(appArgument);
if (!app.startsWith(path.join(mobile, 'build') + path.sep)) throw new Error('Choose an extracted app inside apps/mobile/build.');
const plist = (key) => execFileSync('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', path.join(app, 'Info.plist')], { encoding: 'utf8' }).trim();
if (plist('CFBundleIdentifier') !== 'com.fernandoamaral.bonds') throw new Error('Choose an Everclose native app.');
const platform = plist('DTPlatformName');
if (!['iphoneos', 'iphonesimulator'].includes(platform)) throw new Error('Choose an iOS device or simulator app.');
const nativePaths = ['apps/mobile/package.json', 'apps/mobile/package-lock.json', 'apps/mobile/app.json',
  'apps/mobile/modules', 'apps/mobile/assets', ...['js', 'cjs', 'mjs', 'ts'].flatMap((extension) =>
    ['app', 'metro', 'babel'].map((name) => `apps/mobile/${name}.config.${extension}`))];
const checkedPaths = [...nativePaths, 'apps/mobile/src', 'packages/domain'];
if (execFileSync('git', ['ls-files', '--others', '--exclude-standard', '--', ...checkedPaths],
  { cwd: repository, encoding: 'utf8' }).trim()) throw new Error('Commit app sources/config before refreshing a release bundle.');
execFileSync('git', ['diff', '--quiet', nativeCommit, '--', ...nativePaths], { cwd: repository, stdio: 'pipe' });
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim();
// A commit in the receipt must describe the actual JavaScript being packaged.
execFileSync('git', ['diff', '--quiet', 'HEAD', '--', 'apps/mobile/src', 'packages/domain'], { cwd: repository, stdio: 'pipe' });
const staging = fs.mkdtempSync(path.join(mobile, 'build', 'everclose-bundle-'));
try {
  const bundle = path.join(staging, 'main.jsbundle');
  const assets = path.join(staging, 'assets');
  execFileSync('npx', ['--no-install', 'expo', 'export:embed', '--entry-file', 'node_modules/expo-router/entry.js',
    '--platform', 'ios', '--dev', 'false', '--bytecode', '--bundle-output', bundle, '--assets-dest', assets],
  { cwd: mobile, env: { ...process.env, NODE_ENV: 'production', EXPO_PUBLIC_EVERCLOSE_API_URL: 'https://everclosecrm.com' }, stdio: 'inherit', timeout: 180_000 });
  if (!fs.statSync(bundle).size) throw new Error('The exported bundle is empty.');
  fs.copyFileSync(bundle, path.join(app, 'main.jsbundle'));
  if (fs.existsSync(assets)) fs.cpSync(assets, app, { recursive: true });
  fs.writeFileSync(path.join(app, 'EvercloseRelease.json'), JSON.stringify({ nativeSourceCommit: nativeCommit,
    javascriptSourceCommit: sourceCommit, apiOrigin: 'https://everclosecrm.com',
    bundleSha256: createHash('sha256').update(fs.readFileSync(bundle)).digest('hex') }, null, 2) + '\n');
  if (platform === 'iphonesimulator') {
    // Simulator entitlements already live in the Xcode-linked Mach-O section.
    // Do not add iOS entitlements to the host macOS code signature.
    execFileSync('codesign', ['--force', '--sign', '-', app], { stdio: 'inherit' });
    execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
  }
  console.log(`Updated ${platform} bundle from ${sourceCommit}. Device apps must be signed before installation.`);
} finally {
  fs.rmSync(staging, { recursive: true, force: true });
}
