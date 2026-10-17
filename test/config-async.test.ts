import assert from 'node:assert/strict';
import test from 'node:test';
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mutateConfigFileAsync } from '../config-file-transaction.ts';

test('Windows publication lets a same-process reader close and leaves the UI responsive', { skip: process.platform !== 'win32' }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'pma-async-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'models.json');
  writeFileSync(path, '{"unrelated":true}\n');
  const fd = openSync(path, 'r');
  let closed = false;
  const timer = setTimeout(() => { closeSync(fd); closed = true; }, 40);
  t.after(() => { clearTimeout(timer); if (!closed) closeSync(fd); });
  await mutateConfigFileAsync(path, () => ({ providers: { test: {} } }));
  assert.equal(closed, true, 'the retry must yield to the host reader, not block the event loop');
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { unrelated: true, providers: { test: {} } });
  assert.equal(existsSync(path + '.lock'), false);
});

test('concurrent async config writers merge read-latest patches and preserve no-op formatting', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'pma-async-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'models.json');
  const original = '{ "untouched": true }\n';
  writeFileSync(path, original);
  await mutateConfigFileAsync(path, () => undefined);
  assert.equal(readFileSync(path, 'utf8'), original);
  await Promise.all(['a', 'b', 'c'].map(key => mutateConfigFileAsync(path, disk => ({ providers: { ...disk.providers, [key]: {} } }))));
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { untouched: true, providers: { a: {}, b: {}, c: {} } });
});

test('publication cancelled while a reader is open never replaces the file', { skip: process.platform !== 'win32' }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'pma-async-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'models.json');
  writeFileSync(path, '{"old":true}\n');
  const fd = openSync(path, 'r');
  let active = true, closed = false;
  const timer = setTimeout(() => { active = false; closeSync(fd); closed = true; }, 30);
  t.after(() => { clearTimeout(timer); if (!closed) closeSync(fd); });
  await assert.rejects(mutateConfigFileAsync(path, () => ({ changed: true }), () => active), /session changed/);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { old: true });
  assert.equal(existsSync(path + '.lock'), false);
});

test('async config validation and a stale publisher leave original content and no temporary artifacts', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'pma-async-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'models.json');
  for (const content of ['null', '[]', '{invalid']) {
    writeFileSync(path, content);
    await assert.rejects(mutateConfigFileAsync(path, () => ({ changed: true })));
    assert.equal(readFileSync(path, 'utf8'), content);
    assert.deepEqual(readdirSync(dir), ['models.json']);
  }
  writeFileSync(path, '{}');
  await assert.rejects(mutateConfigFileAsync(path, () => [] as any), /config patch must be an object/);
  await assert.rejects(mutateConfigFileAsync(path, () => ({ changed: true }), () => false), /session changed/);
  assert.equal(readFileSync(path, 'utf8'), '{}');
  assert.deepEqual(readdirSync(dir), ['models.json']);
});
