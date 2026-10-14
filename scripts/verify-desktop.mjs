import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import * as asar from '@electron/asar';
import * as resedit from 'resedit';
const root = fileURLToPath(new URL('../', import.meta.url)), output = path.join(root, 'output/desktop'), result = [];
const selected = process.argv.find(value => value.startsWith('--target='))?.slice('--target='.length).split(',');
async function digest(file) { const hash = createHash('sha256'); for await (const chunk of createReadStream(file)) hash.update(chunk); return hash.digest('hex'); }
const sourceFiles = [];
async function inventory(directory) { for (const entry of await fs.readdir(path.join(root, directory), { withFileTypes: true })) { const file = path.posix.join(directory, entry.name); if (entry.isDirectory()) await inventory(file); else if (entry.isFile()) sourceFiles.push({ path: file, sha256: await digest(path.join(root, file)) }); } }
for (const directory of ['src', 'web', 'resources', 'desktop']) await inventory(directory);
for (const target of await fs.readdir(output)) {
  if (!/^(mac-arm64|mac-x64|win-x64)$/.test(target)) continue;
  if (selected && !selected.includes(target)) continue;
  const directory = path.join(output, target), nativeFile = path.join(directory, 'native-dependencies.json');
  const nativeDependencies = JSON.parse(await fs.readFile(nativeFile));
  const unpacked = target === 'win-x64' ? path.join(directory, 'win-unpacked') : path.join(directory, target === 'mac-arm64' ? 'mac-arm64' : 'mac', 'BuddyLab.app');
  const resources = target === 'win-x64' ? path.join(unpacked, 'resources') : path.join(unpacked, 'Contents/Resources'), archive = path.join(resources, 'app.asar');
  const files = asar.listPackage(archive), required = ['desktop/main.cjs', 'desktop/preload.cjs', 'desktop/backend.cjs', 'desktop/preferences.cjs', 'src/server.mjs', 'web/index.html', 'resources/agency-agents-zh/catalog.json'];
  for (const file of required) if (!files.includes('/' + file)) throw new Error(`Missing package member ${target}: ${file}`);
  for (const source of sourceFiles) if (createHash('sha256').update(asar.extractFile(archive, source.path)).digest('hex') !== source.sha256) throw new Error(`Package differs from final source ${target}: ${source.path}`);
  for (const native of nativeDependencies) if (await digest(path.join(resources, 'app.asar.unpacked', ...native.path.split(/[\\/]/))) !== native.sha256) throw new Error(`Packaged native hash mismatch ${target}`);
  const runtime = JSON.parse(asar.extractFile(archive, 'desktop/runtime.json'));
  const browser = path.join(resources, 'playwright-browsers', runtime.directory, ...runtime.executable); await fs.access(browser);
  let windowsMetadata;
  if (target === 'win-x64') {
    const exe = await fs.readFile(path.join(unpacked, 'BuddyLab.exe')); if (exe.toString('ascii', 0, 2) !== 'MZ' || exe.readUInt16LE(exe.readUInt32LE(0x3c) + 4) !== 0x8664) throw new Error('Windows application is not x64 PE');
    const chrome = await fs.readFile(browser); if (chrome.toString('ascii', 0, 2) !== 'MZ' || chrome.readUInt16LE(chrome.readUInt32LE(0x3c) + 4) !== 0x8664) throw new Error('Windows browser is not x64 PE');
    const entries = resedit.NtExecutableResource.from(resedit.NtExecutable.from(exe)).entries;
    const names = resedit.Resource.VersionInfo.fromEntries(entries).flatMap(item => item.getAvailableLanguages().map(language => item.getStringValues(language).ProductName));
    const icons = resedit.Resource.IconGroupEntry.fromEntries(entries).length;
    if (!names.includes('BuddyLab') || !icons) throw new Error('Windows product metadata/icon missing');
    windowsMetadata = { productName: 'BuddyLab', iconGroups: icons, applicationMachine: 'AMD64', browserMachine: 'AMD64' };
  }
  const artifacts = [];
  for (const name of await fs.readdir(directory)) if (/\.(zip|exe|dmg)$/.test(name)) { const file = path.join(directory, name); artifacts.push({ file: name, bytes: (await fs.stat(file)).size, sha256: await digest(file) }); }
  const smokeName = target === 'mac-x64' ? 'packaged-intel-smoke.json' : 'packaged-smoke.json';
  const smoke = target === 'win-x64' ? null : await fs.readFile(path.join(output, smokeName), 'utf8').then(JSON.parse).catch(() => null);
  const verified = smoke?.secureRestoreAfterRestart && smoke?.toolRuntime?.pdfCreatedAndRead && smoke.arch === (target === 'mac-x64' ? 'x64' : 'arm64');
  result.push({ target, members: files.length, finalSourceFilesMatched: sourceFiles.length, resourcesIncluded: true, chromiumVersion: runtime.chromiumVersion, browserBytes: (await fs.stat(browser)).size, nativeDependencies, ...(windowsMetadata ? { windowsMetadata } : {}), artifacts,
    runtimeVerification: verified ? target === 'mac-x64' ? 'Actual x64 app/backend/browser/Office/storage smoke passed via Rosetta on arm64; native Intel hardware not tested' : 'Actual native arm64 app/backend/browser/Office/storage smoke passed' : 'Cross-built structural validation; target OS execution not tested', ...(verified ? { runtimeReport: smokeName } : {}) });
}
await fs.writeFile(path.join(output, 'build-verification.json'), JSON.stringify(result, null, 2));
await fs.writeFile(path.join(output, 'source-manifest.json'), JSON.stringify(sourceFiles, null, 2));
console.log(result.map(item => ({ target: item.target, artifacts: item.artifacts.length, nativeModules: item.nativeDependencies.length })));
