import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = fileURLToPath(new URL('../', import.meta.url));
const PHOTO = '/9j/4AAQSkZJRgABAQAAAQABAAD/2Q==';
function fixture({ canceled = false, size = 1000, uri = 'file:///private-app/cache/ImagePicker/source.jpg', width = 800, height = 1200, base64 = PHOTO } = {}) {
  const deleted: string[] = [], calls: Array<[string, unknown]> = [], released: string[] = [];
  let pickerOptions: unknown;
  const image = { async saveAsync(options: unknown) { calls.push(['save', options]); return { uri: 'file:///private-app/cache/ImageManipulator/result.jpg', base64 }; }, release() { released.push('image'); } };
  const context = { crop(options: unknown) { calls.push(['crop', options]); return this; }, resize(options: unknown) { calls.push(['resize', options]); return this; }, async renderAsync() { return image; }, release() { released.push('context'); } };
  const modules: Record<string, unknown> = {
    'expo-image-picker': { async launchImageLibraryAsync(options: unknown) { pickerOptions = options; return canceled ? { canceled: true, assets: null } : { canceled: false, assets: [{ uri, width, height, fileSize: size }] }; } },
    'expo-image-manipulator': { SaveFormat: { JPEG: 'jpeg' }, ImageManipulator: { manipulate(source: string) { assert.equal(source, uri); return context; } } },
    'expo-file-system': { Paths: { cache: { uri: 'file:///private-app/cache/' } }, File: class { exists = true; size = size; uri: string; constructor(uri: string) { this.uri = uri; } delete() { deleted.push(this.uri); } } },
  };
  function load(filename: string): Record<string, unknown> {
    if (!path.extname(filename)) filename += '.ts';
    const loaded = { exports: {} as Record<string, unknown> };
    const code = ts.transpileModule(readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    new Function('require', 'module', 'exports', code)((name: string) => modules[name] ?? load(path.resolve(path.dirname(filename), name)), loaded, loaded.exports);
    return loaded.exports;
  }
  const picker = load(path.join(root, 'apps/mobile/src/native/photo-picker.ts')) as typeof import('../apps/mobile/src/native/photo-picker.ts');
  return { picker, calls, deleted, released, options: () => pickerOptions };
}
test('the system picker cancellation never changes a photo or creates a file', async () => {
  const f = fixture({ canceled: true });
  assert.equal(await f.picker.chooseContactPhoto(() => true), null);
  assert.deepEqual(f.calls, []); assert.deepEqual(f.deleted, []);
  assert.deepEqual(f.options(), { mediaTypes: ['images'], allowsEditing: false, quality: 1 });
});
test('selected portrait photos are reencoded as a bounded JPEG and only app-owned temporary copies are removed', async () => {
  const f = fixture();
  assert.equal(await f.picker.chooseContactPhoto(() => true), 'data:image/jpeg;base64,' + PHOTO);
  assert.deepEqual(f.calls[0], ['crop', { originX: 0, originY: 200, width: 800, height: 800 }]);
  assert.deepEqual(f.calls[1], ['resize', { width: 320, height: 320 }]);
  assert.deepEqual(f.calls[2], ['save', { format: 'jpeg', compress: 0.82, base64: true }]);
  assert.deepEqual(f.deleted, ['file:///private-app/cache/ImageManipulator/result.jpg', 'file:///private-app/cache/ImagePicker/source.jpg']);
  assert.deepEqual(f.released, ['image', 'context']);
});
test('an account switch while Photos is open discards the late selection', async () => {
  const f = fixture();
  assert.equal(await f.picker.chooseContactPhoto(() => false), null);
  assert.deepEqual(f.calls, []); assert.deepEqual(f.deleted, ['file:///private-app/cache/ImagePicker/source.jpg']);
});
test('oversized photos are rejected before decoding and the user library original is never deleted', async () => {
  const f = fixture({ size: 11 * 1024 * 1024, uri: 'file:///user-photos/ImagePicker/original.jpg' });
  await assert.rejects(f.picker.chooseContactPhoto(() => true), /under 10 MB/);
  assert.deepEqual(f.calls, []); assert.deepEqual(f.deleted, []);
});
test('a corrupt image result cannot enter the editor and native resources are released', async () => {
  const f = fixture({ base64: 'not-a-JPEG' });
  await assert.rejects(f.picker.chooseContactPhoto(() => true), /too large after resizing/);
  assert.equal(f.calls.filter(([action]) => action === 'save').length, 2);
  assert.deepEqual(f.released, ['image', 'context']);
});
