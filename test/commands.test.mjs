import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeTool } from '../src/tools.mjs';

test('命令真实期限终止与长输出末尾保留，默认可执行构建任务', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'buddy-command-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stopped = await executeTool('run_command', { command: "printf started; sleep 3; printf finished", timeoutSeconds: 1 }, { root });
  assert.equal(stopped.timedOut, true); assert.equal(stopped.timeoutSeconds, 1); assert.match(stopped.output, /started/); assert.doesNotMatch(stopped.output, /finished/);
  const result = await executeTool('run_command', { command: "awk 'BEGIN { printf \"HEAD\"; for(i=0;i<30000;i++) printf \"x\"; printf \"TAIL\" }'" }, { root });
  assert.equal(result.exitCode, 0); assert.equal(result.timeoutSeconds, 120); assert.equal(result.truncated, true); assert.ok(result.output.startsWith('HEAD')); assert.ok(result.output.endsWith('TAIL')); assert.ok(result.output.length <= 10000);
  await assert.rejects(executeTool('run_command', { command: 'printf should-not-run', timeoutSeconds: 301 }, { root }), /1–300/);
});
