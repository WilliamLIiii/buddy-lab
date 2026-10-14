import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || major === 22 && minor < 13) { console.error('开发和命令行模式需要Node.js22.13或更新版本；安装后的桌面客户端自带运行时。'); process.exit(1); }
const mode = process.argv[2] || 'start';
const args = mode === 'test' ? ['--test', ...(await readdir(new URL('../test/', import.meta.url))).filter(name => name.endsWith('.test.mjs')).map(name => `test/${name}`), ...process.argv.slice(3)] : ['src/server.mjs', ...process.argv.slice(3)];
const child = spawn(process.execPath, args, { cwd: root, stdio: 'inherit', env: process.env });
child.once('error', () => process.exit(1)); child.once('exit', code => process.exit(code ?? 1));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
