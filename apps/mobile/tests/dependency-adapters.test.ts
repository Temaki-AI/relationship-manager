import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const assets = require('metro/private/Assets');
const queryString = require('query-string');
const mobileDirectory = new URL('../', import.meta.url);
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=',
  'base64',
);

test('Metro preserves buffer, file, scale and zip-directory image dimensions', async () => {
  assert.deepEqual(assets.getAssetSize('png', png, 'fixture.png'), { width: 1, height: 1 });
  assert.deepEqual(
    assets.getAssetSize('svg', Buffer.from('<svg width="18" height="27"></svg>'), 'fixture.svg'),
    { width: 18, height: 27 },
  );
  assert.equal(assets.getAssetSize('txt', Buffer.from('non-image'), 'fixture.txt'), null);
  assert.throws(() => assets.getAssetSize('png', Buffer.alloc(0), 'empty.png'), /empty file/);

  const directory = await mkdtemp(join(tmpdir(), 'everclose-asset-adapter-'));
  try {
    const zipDirectory = join(directory, 'fixture.zip');
    await mkdir(zipDirectory);
    for (const parent of [directory, zipDirectory]) {
      const path = join(parent, 'pixel@2x.png');
      await writeFile(path, png);
      const data = await assets.getAssetData(path, 'fixtures', [], 'ios', '/assets');
      assert.equal(data.width, 0.5);
      assert.equal(data.height, 0.5);
      assert.equal(data.name, 'pixel');
      assert.equal(data.type, 'png');
      assert.deepEqual(data.scales, [2]);
      assert.deepEqual(data.files, [path]);
      assert.match(data.hash, /^[a-f0-9]{32}$/);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Metro rejects zero-sized HEIF, JXL and ICNS boxes without hanging', () => {
  // Run outside the test runner so a regressed parser has a hard termination
  // deadline. Recognizable headers reach the affected format walkers.
  const output = execFileSync(process.execPath, ['-e', `
    const assert = require('node:assert/strict');
    const fs = require('node:fs/promises');
    const os = require('node:os');
    const path = require('node:path');
    const assets = require('metro/private/Assets');
    const fixtures = [
      Buffer.from('00000014667479706865696300000000686569630000000066726565', 'hex'),
      Buffer.from('0000000c4a584c200d0a870a00000014667479706a786c20000000006a786c20000000006a756e6b', 'hex'),
      Buffer.from('69636e73000000106963303700000000', 'hex'),
    ];
    (async () => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'everclose-malformed-asset-'));
      try {
        for (const [index, content] of fixtures.entries()) {
          assert.throws(() => assets.getAssetSize('png', content, 'malformed.png'), /Invalid/);
          const file = path.join(directory, 'malformed-' + index + '.png');
          await fs.writeFile(file, content);
          await assert.rejects(assets.getAssetData(file, 'fixtures', [], 'ios', '/assets'), /Invalid/);
        }
        process.stdout.write('three formats rejected via buffer and file');
      } finally { await fs.rm(directory, {recursive: true, force: true}); }
    })().catch(error => { process.stderr.write(String(error)); process.exitCode = 1; });
  `], { cwd: mobileDirectory, encoding: 'utf8', timeout: 5000 });
  assert.equal(output, 'three formats rejected via buffer and file');
});

test('Router query dependency preserves Unicode, contact methods and repeated parameters', () => {
  const parsed = queryString.parse(
    'name=Jo%C3%A3o&email=ada%2Bwork%40example.invalid&note=A%26B+%3D+C&tag=a&tag=b&flag&empty=',
  );
  assert.deepEqual({ ...parsed }, {
    name: 'João', email: 'ada+work@example.invalid', note: 'A&B = C',
    tag: ['a', 'b'], flag: null, empty: '',
  });
  assert.deepEqual(queryString.parse(queryString.stringify(parsed)), parsed);
  assert.deepEqual({ ...queryString.parse('tag[]=a&tag[]=b', { arrayFormat: 'bracket' }) }, { tag: ['a', 'b'] });
  assert.deepEqual({ ...queryString.parse('tag=a%2Cb', { arrayFormat: 'comma' }) }, { tag: ['a', 'b'] });
  assert.deepEqual({ ...queryString.parse('value=%FE%FF&literal=%G1&partial=%C2') }, {
    value: '��', literal: '%G1', partial: '�',
  });
});

test('Router query dependency decodes long malformed input within a hard deadline', () => {
  const output = execFileSync(process.execPath, ['-e', `
    const assert = require('node:assert/strict');
    const query = require('query-string');
    const malformed = '%C0'.repeat(20000);
    const parsed = query.parse('person=Jo%C3%A3o&payload=' + malformed);
    assert.equal(parsed.person, 'João');
    assert.equal(parsed.payload, malformed);
    process.stdout.write('malformed input preserved without recursion');
  `], { cwd: mobileDirectory, encoding: 'utf8', timeout: 5000 });
  assert.equal(output, 'malformed input preserved without recursion');
});

test('mobile dependency adapters reapply without changing their behavior', () => {
  execFileSync('npm', ['run', 'postinstall'], {
    cwd: mobileDirectory, encoding: 'utf8', timeout: 15000,
  });
  assert.deepEqual(assets.getAssetSize('png', png, 'fixture.png'), { width: 1, height: 1 });
  assert.equal(queryString.parse('name=Jo%C3%A3o').name, 'João');
});
