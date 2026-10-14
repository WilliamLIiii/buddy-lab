import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeTool } from '../src/tools.mjs';

test('Windows命令超时终止自己cmd及Node子孙进程树', { skip: process.platform !== 'win32' }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'buddylab-windows-command-'))); const pids = [];
  t.after(async () => { for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch {} } await rm(root, { recursive: true, force: true }); });
  await writeFile(join(root, 'child.cjs'), "require('node:fs').writeFileSync('child.pid',String(process.pid));setInterval(()=>{},1000);");
  await writeFile(join(root, 'parent.cjs'), "require('node:fs').writeFileSync('parent.pid',String(process.pid));require('node:child_process').spawn(process.execPath,['child.cjs'],{stdio:'inherit'});setInterval(()=>{},1000);");
  const result = await executeTool('run_command', { command: 'node parent.cjs', timeoutSeconds: 2 }, { root });
  for (const name of ['parent.pid', 'child.pid']) { const pid = Number(await readFile(join(root, name), 'utf8')); assert.ok(Number.isInteger(pid) && pid > 0); pids.push(pid); }
  assert.equal(result.timedOut, true);
  for (const pid of pids) assert.throws(() => process.kill(pid, 0), /ESRCH/);
});
