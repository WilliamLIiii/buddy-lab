import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import electronBuilder from 'electron-builder';
import unzipper from 'unzipper';
const { build, Platform, Arch } = electronBuilder;

const root = fileURLToPath(new URL('../', import.meta.url)), staging = path.join(root, '.desktop-build'), output = path.join(root, 'output/desktop');
const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'))), browsers = JSON.parse(await fs.readFile(path.join(root, 'node_modules/playwright-core/browsers.json')));
const browser = browsers.browsers.find(item => item.name === 'chromium-headless-shell');
const selected = process.argv.find(item => item.startsWith('--target='))?.split('=')[1] || 'mac-arm64,win-x64,mac-x64';
const targets = { 'mac-arm64': { platform: 'darwin', arch: 'arm64', cft: 'mac-arm64', executable: ['chrome-headless-shell-mac-arm64', 'chrome-headless-shell'] },
  'mac-x64': { platform: 'darwin', arch: 'x64', cft: 'mac-x64', executable: ['chrome-headless-shell-mac-x64', 'chrome-headless-shell'] },
  'win-x64': { platform: 'win32', arch: 'x64', cft: 'win64', executable: ['chrome-headless-shell-win64', 'chrome-headless-shell.exe'] } };
async function command(binary, args, cwd, env = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd, env: { ...process.env, ...env }, stdio: 'inherit' });
    child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${path.basename(binary)} exited ${code}`)));
  });
}
async function digest(file) { const hash = createHash('sha256'); for await (const chunk of createReadStream(file)) hash.update(chunk); return hash.digest('hex'); }
async function prepareIcons() {
  const directory = path.join(root, 'desktop/assets'); await fs.mkdir(directory, { recursive: true });
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><rect x="12" y="12" width="488" height="488" rx="112" fill="#1576db"/><path d="M153 118h119c66 0 104 30 104 79 0 33-19 57-49 69 40 9 64 34 64 73 0 57-43 86-115 86H153V118zm72 61v65h40c27 0 41-12 41-33 0-21-14-32-42-32h-39zm0 122v62h47c32 0 48-10 48-31 0-21-16-31-48-31h-47z" fill="white"/></svg>';
  await fs.writeFile(path.join(directory, 'icon.svg'), svg); await sharp(Buffer.from(svg)).png().toFile(path.join(directory, 'icon.png'));
  const png = await sharp(Buffer.from(svg)).resize(256, 256).png().toBuffer(), ico = Buffer.alloc(22);
  ico.writeUInt16LE(1, 2); ico.writeUInt16LE(1, 4); ico.writeUInt16LE(1, 10); ico.writeUInt16LE(32, 12); ico.writeUInt32LE(png.length, 14); ico.writeUInt32LE(22, 18);
  await fs.writeFile(path.join(directory, 'icon.ico'), Buffer.concat([ico, png]));
  if (process.platform === 'darwin') {
    const iconset = path.join(staging, 'icon.iconset'); await fs.mkdir(iconset, { recursive: true });
    for (const size of [16, 32, 128, 256, 512]) {
      await sharp(Buffer.from(svg)).resize(size, size).png().toFile(path.join(iconset, `icon_${size}x${size}.png`));
      await sharp(Buffer.from(svg)).resize(size * 2, size * 2).png().toFile(path.join(iconset, `icon_${size}x${size}@2x.png`));
    }
    await command('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', path.join(directory, 'icon.icns')], root);
  }
}
async function prepareBrowser(id, target) {
  const directory = `chromium_headless_shell-${browser.revision}`, cache = path.join(staging, 'cache/browsers', id, directory), executable = path.join(cache, ...target.executable);
  try { await fs.access(executable); return { directory, cache, executable: target.executable }; } catch {}
  if (process.platform === target.platform && process.arch === target.arch) {
    const installed = path.join(os.homedir(), process.platform === 'darwin' ? 'Library/Caches/ms-playwright' : 'AppData/Local/ms-playwright', directory);
    try { await fs.access(path.join(installed, ...target.executable)); await fs.mkdir(path.dirname(cache), { recursive: true }); await fs.cp(installed, cache, { recursive: true }); return { directory, cache, executable: target.executable }; } catch {}
  }
  const url = `https://storage.googleapis.com/chrome-for-testing-public/${browser.browserVersion}/${target.cft}/chrome-headless-shell-${target.cft}.zip`;
  const zip = path.join(staging, 'cache', `chromium-${id}-${browser.revision}.zip`); await fs.mkdir(path.dirname(zip), { recursive: true });
  try { await fs.access(zip); } catch {
    console.log(`Downloading pinned Chromium headless ${id} ${browser.browserVersion}`);
    const response = await fetch(url); if (!response.ok || !response.body) throw new Error(`Chromium download failed HTTP ${response.status}`);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(zip + '.download')); await fs.rename(zip + '.download', zip);
  }
  await fs.mkdir(cache, { recursive: true }); await (await unzipper.Open.file(zip)).extract({ path: cache }); await fs.access(executable);
  if (target.platform === 'darwin') await fs.chmod(executable, 0o755);
  await fs.writeFile(path.join(path.dirname(cache), 'download-provenance.json'), JSON.stringify({ url, revision: browser.revision, version: browser.browserVersion, archiveSha256: await digest(zip) }, null, 2));
  return { directory, cache, executable: target.executable };
}
async function nativeManifest(appDir, target) {
  const files = [];
  async function walk(directory) { for (const entry of await fs.readdir(directory, { withFileTypes: true })) { const file = path.join(directory, entry.name); if (entry.isDirectory()) await walk(file); else if (entry.isFile() && file.endsWith('.node')) files.push(file); } }
  await walk(path.join(appDir, 'node_modules'));
  if (files.length < 2) throw new Error('Target native sharp/canvas modules are missing');
  const rows = [];
  for (const file of files) {
    const bytes = await fs.readFile(file); let architecture;
    if (target.platform === 'win32') { if (bytes.toString('ascii', 0, 2) !== 'MZ' || bytes.readUInt16LE(bytes.readUInt32LE(0x3c) + 4) !== 0x8664) throw new Error('Windows staging contains a non-x64 PE native module'); architecture = 'PE-x64'; }
    else {
      const expected = target.arch === 'arm64' ? 0x100000c : 0x1000007;
      let supported = bytes.readUInt32LE(0) === 0xfeedfacf && bytes.readUInt32LE(4) === expected;
      const magic = bytes.readUInt32BE(0);
      if (magic === 0xcafebabe || magic === 0xcafebabf) { const count = bytes.readUInt32BE(4), step = magic === 0xcafebabf ? 32 : 20; supported = Array.from({ length: count }, (_, i) => bytes.readUInt32BE(8 + i * step)).includes(expected); }
      if (!supported) throw new Error(`Mac staging contains wrong-architecture native module: ${path.basename(file)}`); architecture = `MachO-${target.arch}${magic === 0xcafebabe || magic === 0xcafebabf ? '-universal' : ''}`;
    }
    rows.push({ path: path.relative(appDir, file), architecture, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  return rows;
}
await prepareIcons();
const requested = selected.split(','); for (const id of requested) if (!targets[id]) throw new Error(`Unknown target ${id}`);
const browserAssets = new Map(await Promise.all(requested.map(async id => [id, await prepareBrowser(id, targets[id])])));
for (const id of requested) {
  const target = targets[id], appDir = path.join(staging, id, 'app'), assets = browserAssets.get(id), helpers = path.join(staging, id, 'helpers');
  await fs.mkdir(appDir, { recursive: true });
  for (const directory of ['src', 'web', 'resources', 'desktop']) {
    await fs.rm(path.join(appDir, directory), { recursive: true, force: true }); await fs.cp(path.join(root, directory), path.join(appDir, directory), { recursive: true });
  }
  await fs.rm(path.join(appDir, 'web/assets/reference'), {recursive:true,force:true});
  for(const file of ['LICENSE','DISCLAIMER.md','THIRD_PARTY_NOTICES.md'])await fs.copyFile(path.join(root,file),path.join(appDir,file));
  const appPackage = { name: pkg.name, productName: 'BuddyLab', version: pkg.version, private: true, type: 'module', main: 'desktop/main.cjs', description: 'Local desktop AI workbench', author: 'BuddyLab', license: 'SEE LICENSE IN LICENSE', dependencies: pkg.dependencies, overrides: pkg.overrides };
  await fs.writeFile(path.join(appDir, 'package.json'), JSON.stringify(appPackage, null, 2));
  await fs.writeFile(path.join(appDir, 'desktop/runtime.json'), JSON.stringify({ directory: assets.directory, executable: assets.executable, target: id, chromiumVersion: browser.browserVersion }, null, 2));
  const installed = await fs.access(path.join(appDir, 'node_modules')).then(() => true).catch(() => false);
  if (!process.argv.includes('--reuse-stage') || !installed) { await fs.rm(path.join(appDir, 'node_modules'), { recursive: true, force: true }); await fs.rm(path.join(appDir, 'package-lock.json'), { force: true });
    const installArgs = ['install', '--omit=dev', '--include=optional', '--ignore-scripts', `--os=${target.platform}`, `--cpu=${target.arch}`, '--no-audit', '--no-fund'];
    if (process.platform === 'win32') {
      // .cmd files cannot be spawned directly with shell:false on Windows.
      const npmCLI = process.env.npm_execpath || path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
      await fs.access(npmCLI); await command(process.execPath, [npmCLI, ...installArgs], appDir);
    } else await command('npm', installArgs, appDir);
  }
  const natives = await nativeManifest(appDir, target); await fs.mkdir(path.join(output, id), { recursive: true });
  await fs.writeFile(path.join(output, id, 'native-dependencies.json'), JSON.stringify(natives, null, 2));
  const extraResources = [{ from: assets.cache, to: `playwright-browsers/${assets.directory}` }];
  if (target.platform === 'darwin') {
    await fs.mkdir(helpers, { recursive: true });
    await command('/usr/bin/xcrun', ['swiftc', '-O', '-target', `${target.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macos14.0`, path.join(root, 'src/keychain-helper.swift'), '-o', path.join(helpers, 'buddylab-keychain')], root);
    extraResources.push({ from: helpers, to: 'helpers' });
  }
  const config = { appId: 'com.buddylab.desktop', productName: 'BuddyLab', electronVersion: pkg.devDependencies.electron, directories: { app: appDir, output: path.join(output, id) },
    asar: true, asarUnpack: ['**/*.node', '**/*.dll', '**/*.dylib'], npmRebuild: false, nodeGypRebuild: false, publish: null,
    files: ['package.json','LICENSE','DISCLAIMER.md','THIRD_PARTY_NOTICES.md', 'src/**', 'web/**', 'resources/**', 'desktop/**', 'node_modules/**'], extraResources,
    artifactName: 'BuddyLab-${version}-${os}-${arch}.${ext}', mac: { target: 'zip', icon: path.join(root, 'desktop/assets/icon.icns'), identity: null, hardenedRuntime: false, gatekeeperAssess: false, minimumSystemVersion: '14.0' },
    win: { target: ['nsis', 'portable'], icon: path.join(root, 'desktop/assets/icon.ico'), signExecutable: false, requestedExecutionLevel: 'asInvoker' }, nsis: { oneClick: false, perMachine: false, allowToChangeInstallationDirectory: true }, portable: { artifactName: 'BuddyLab-${version}-windows-${arch}-portable.exe' }
  };
  console.log(`Packaging ${id} with ${natives.length} verified native modules and Chromium ${browser.browserVersion}`);
  process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
  await build({ targets: target.platform === 'darwin' ? Platform.MAC.createTarget(['zip'], target.arch === 'arm64' ? Arch.arm64 : Arch.x64) : Platform.WINDOWS.createTarget(['nsis', 'portable'], Arch.x64), config });
}
