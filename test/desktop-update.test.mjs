import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import * as asar from '@electron/asar';
import { buildExistingAsarCandidate } from '../scripts/update-existing-desktop.mjs';

async function fixture(t) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'buddy-desktop-update-test-')), sourceRoot = path.join(temporary, 'source');
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  await fs.mkdir(sourceRoot); const dependencies = { 'fixture-only': '1.0.0' }, packageObject = { name: 'buddy-lab', main: 'desktop/main.cjs', version: '0.4.0', dependencies, overrides: {} };
  const bytes = new Map([['package.json', Buffer.from(JSON.stringify(packageObject))], ['desktop/runtime.json', Buffer.from('{"target":"mac-arm64","executable":["pinned-browser"]}')], ['desktop/main.cjs', Buffer.from('old desktop')], ['src/server.mjs', Buffer.from('old source')], ['web/index.html', Buffer.from('old web')], ['resources/agency/catalog.json', Buffer.from('{"source":{"license":"MIT"}}')], ['node_modules/fixture/index.js', Buffer.from('unchanged dependency')], ['node_modules/fixture/native.node', Buffer.from('fixture-opaque-native-bytes')]]);
  const archive = path.join(temporary, 'old.asar');
  await finished(await asar.createPackageFromStreams(archive, [...bytes].map(([name, body]) => ({ path: name, type: 'file', unpacked: name.endsWith('.node'), stat: { size: body.length, mode: 0o644 }, streamGenerator: () => Readable.from([body]) }))));
  for (const directory of ['desktop', 'src', 'web', 'resources']) await fs.mkdir(path.join(sourceRoot, directory));
  await fs.writeFile(path.join(sourceRoot, 'package.json'), JSON.stringify({ ...packageObject, version: '0.4.1' }));
  await fs.writeFile(path.join(sourceRoot, 'desktop/main.cjs'), 'new desktop'); await fs.writeFile(path.join(sourceRoot, 'src/server.mjs'), 'new source'); await fs.writeFile(path.join(sourceRoot, 'web/index.html'), 'new web'); await fs.writeFile(path.join(sourceRoot, 'resources/public.txt'), 'public resource');
  await fs.mkdir(path.join(sourceRoot, '.data')); await fs.writeFile(path.join(sourceRoot, '.data/private.txt'), 'do not bundle personal state');
  return { temporary, sourceRoot, archive, bytes };
}

test('官方ASAR stream更新只更换公共代码/version，保留目标依赖/native/unpack/runtime，源.data不入包', async t => {
  const f = await fixture(t), built = await buildExistingAsarCandidate({ ...f, version: '0.4.1' });
  assert.equal(asar.extractFile(built.candidate, 'src/server.mjs').toString(), 'new source'); assert.equal(JSON.parse(asar.extractFile(built.candidate, 'package.json')).version, '0.4.1');
  for (const name of ['node_modules/fixture/index.js', 'node_modules/fixture/native.node', 'desktop/runtime.json']) assert.deepEqual(asar.extractFile(built.candidate, name), f.bytes.get(name));
  assert.equal(asar.statFile(built.candidate, 'node_modules/fixture/native.node').unpacked, true);
  assert.equal(asar.listPackage(built.candidate).some(name => name.includes('.data')), false);
  assert.deepEqual(asar.extractFile(f.archive, 'src/server.mjs'), f.bytes.get('src/server.mjs'));
  assert.equal(built.preservedUnpackedFiles, 1);
});

test('依赖版本改变或个人专家快照混入public resources时拒绝轻量更新', async t => {
  const f = await fixture(t), config = JSON.parse(await fs.readFile(path.join(f.sourceRoot, 'package.json')));
  await fs.writeFile(path.join(f.sourceRoot, 'package.json'), JSON.stringify({ ...config, dependencies: { 'fixture-only': '2.0.0' } }));
  await assert.rejects(buildExistingAsarCandidate({ ...f, version: '0.4.1' }), /Dependencies changed/);
  await fs.writeFile(path.join(f.sourceRoot, 'package.json'), JSON.stringify(config));
  await fs.writeFile(path.join(f.sourceRoot, 'resources/catalog.json'), '{"source":{"kind":"user-provided-local"}}');
  await assert.rejects(buildExistingAsarCandidate({ ...f, version: '0.4.1' }), /Personal expert snapshots/);
});
