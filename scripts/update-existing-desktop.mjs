import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import * as asar from '@electron/asar';
import { inspectDesktopProcesses } from './desktop-process-identity.mjs';

const command = promisify(execFile), project = fileURLToPath(new URL('../', import.meta.url));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const issue = message => new Error(message);
function relativeFile(value) {
  if (!value || value.startsWith('/') || /[\\:\0]/.test(value) || value.split('/').some(part => !part || part === '.' || part === '..')) throw issue('Unsafe archive/source path');
  if (value.split('/').some(part => ['.data', 'workspaces', 'workbuddy-experts', 'marketplaces'].includes(part))) throw issue('Personal data must not enter the desktop archive');
  return value;
}
async function shaFile(file) { const hash = createHash('sha256'); for await (const bytes of createReadStream(file)) hash.update(bytes); return hash.digest('hex'); }
const canonical = value => value && typeof value === 'object' ? Array.isArray(value) ? value.map(canonical) : Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
async function publicFiles(sourceRoot) {
  const rows = [];
  async function walk(relative) {
    relativeFile(relative); const absolute = path.join(sourceRoot, relative), stat = await fs.lstat(absolute);
    if (stat.isSymbolicLink()) throw issue('Public source contains a symlink');
    if (stat.isDirectory()) { rows.push({ path: relative, type: 'directory', unpacked: false, stat }); for (const name of (await fs.readdir(absolute)).sort()) await walk(`${relative}/${name}`); }
    else if (stat.isFile()) {
      if (stat.size > 32 * 1024 * 1024 || /(?:^|\/)\.env(?:\.|$)/.test(relative)) throw issue('Unexpected public source file');
      const sha256 = await shaFile(absolute);
      if (relative.startsWith('resources/') && relative.endsWith('catalog.json')) {
        const value = JSON.parse(await fs.readFile(absolute, 'utf8')); if (value.source?.kind === 'user-provided-local') throw issue('Personal expert snapshots cannot be bundled');
      }
      rows.push({ path: relative, type: 'file', unpacked: false, stat, absolute, sha256, streamGenerator: () => createReadStream(absolute) });
    } else throw issue('Public source contains a special file');
  }
  for (const directory of ['src', 'web', 'desktop', 'resources']) await walk(directory);
  return rows;
}
function packageRows(archive) {
  return asar.listPackage(archive).map(raw => {
    const name = relativeFile(raw.replace(/^\//, '')), info = asar.statFile(archive, name, false);
    if ('link' in info) throw issue('Existing archive links require an explicit migration');
    return { path: name, type: 'files' in info ? 'directory' : 'file', unpacked: Boolean(info.unpacked), stat: { size: info.size || 0, mode: info.executable ? 0o755 : 0o644 }, info,
      streamGenerator: () => { const bytes = asar.extractFile(archive, name); if (info.integrity?.hash && digest(bytes) !== info.integrity.hash) throw issue('Existing archive file integrity mismatch'); return Readable.from([bytes]); } };
  });
}
async function verifyCandidate(candidate, oldArchive, sourceRows, version) {
  const preserved = packageRows(oldArchive).filter(row => row.type === 'file' && (row.path.startsWith('node_modules/') || row.path === 'desktop/runtime.json'));
  for (const row of preserved) {
    const actual = asar.statFile(candidate, row.path, false), bytes = asar.extractFile(candidate, row.path);
    if (Boolean(actual.unpacked) !== row.unpacked || digest(bytes) !== digest(asar.extractFile(oldArchive, row.path))) throw issue('Dependency/runtime bytes or unpack flags changed');
  }
  for (const row of sourceRows.filter(row => row.type === 'file' && row.path !== 'desktop/runtime.json')) {
    if (digest(asar.extractFile(candidate, row.path)) !== row.sha256 || await shaFile(row.absolute) !== row.sha256) throw issue('Candidate/source mismatch or source changed during preparation');
  }
  if (JSON.parse(asar.extractFile(candidate, 'package.json')).version !== version) throw issue('Candidate package version mismatch');
  return { preservedFiles: preserved.length, publicFiles: sourceRows.filter(row => row.type === 'file' && row.path !== 'desktop/runtime.json').length, preservedUnpackedFiles: preserved.filter(row => row.unpacked).length };
}

export async function buildExistingAsarCandidate({ archive, sourceRoot, version, temporary }) {
  if (!/^\d+\.\d+\.\d+$/.test(version || '')) throw issue('Version must be a release x.y.z');
  const oldPackage = JSON.parse(asar.extractFile(archive, 'package.json')), sourcePackage = JSON.parse(await fs.readFile(path.join(sourceRoot, 'package.json'), 'utf8'));
  if (oldPackage.name !== 'buddy-lab' || sourcePackage.name !== 'buddy-lab' || oldPackage.main !== 'desktop/main.cjs') throw issue('Target is not this BuddyLab desktop');
  if (!same(oldPackage.dependencies, sourcePackage.dependencies) || !same(oldPackage.overrides, sourcePackage.overrides)) throw issue('Dependencies changed; this update cannot install or replace dependencies');
  const rows = await publicFiles(sourceRoot), next = new Map(packageRows(archive).filter(row => !['src', 'web', 'desktop', 'resources'].some(directory => row.path === directory || row.path.startsWith(directory + '/')) || row.path === 'desktop/runtime.json').map(row => [row.path, row]));
  for (const row of rows) if (row.path !== 'desktop/runtime.json') next.set(row.path, row);
  const packageBytes = Buffer.from(JSON.stringify({ ...oldPackage, version }, null, 2) + '\n');
  next.set('package.json', { path: 'package.json', type: 'file', unpacked: false, stat: { size: packageBytes.length, mode: 0o644 }, streamGenerator: () => Readable.from([packageBytes]) });
  const candidate = path.join(temporary, 'candidate.asar'), streams = [...next.values()].sort((a, b) => a.path.localeCompare(b.path));
  const output = await asar.createPackageFromStreams(candidate, streams); await finished(output);
  const verified = await verifyCandidate(candidate, archive, rows, version);
  const newHeaderSha256 = digest(asar.getRawHeader(candidate).headerString);
  return { candidate, rows, version, previousVersion: oldPackage.version, newHeaderSha256, ...verified };
}
async function plist(file, operation) { return (await command('/usr/libexec/PlistBuddy', ['-c', operation, file])).stdout.trim(); }
async function assertNotRunning(appPath, executable) {
  const helperExecutables = [], framework = path.join(appPath, 'Contents/Frameworks');
  for (const entry of await fs.readdir(framework, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() || !entry.name.endsWith('.app')) continue;
    const bundle = path.join(framework, entry.name), info = path.join(bundle, 'Contents/Info.plist');
    try { const id = await plist(info, 'Print :CFBundleIdentifier'), name = await plist(info, 'Print :CFBundleExecutable'); if (!id.startsWith('com.buddylab.desktop.helper') || !name || /[\\/\0]/.test(name)) continue; helperExecutables.push(await fs.realpath(path.join(bundle, 'Contents/MacOS', name))); } catch {}
  }
  const state = await inspectDesktopProcesses({ appPath, executable, helperExecutables });
  if (state.status === 'active') throw issue('Verified target executable or related helper is running. Quit this BuddyLab client first; its external backend must remain running.');
  if (state.status !== 'inactive') throw issue('Target process state is unknown: actual executable/parent facts are unavailable. No command-text or PID-prefix fallback was used.');
}
async function atomicCopy(source, destination) {
  const temporary = `${destination}.update-${randomUUID()}`;
  try { await fs.copyFile(source, temporary); const handle = await fs.open(temporary, 'r+'); try { await handle.sync(); } finally { await handle.close(); } await fs.rename(temporary, destination); }
  finally { await fs.rm(temporary, { force: true }); }
}

export async function updateExistingDesktop({ appPath, sourceRoot = project, apply = false, version, backupRoot = path.join(project, 'output/desktop-updates') }) {
  if (process.platform !== 'darwin') throw issue('This in-place updater is for the existing Mac client only');
  appPath = await fs.realpath(appPath); sourceRoot = await fs.realpath(sourceRoot);
  const resources = path.join(appPath, 'Contents/Resources'), archive = path.join(resources, 'app.asar'), infoFile = path.join(appPath, 'Contents/Info.plist');
  if (await plist(infoFile, 'Print :CFBundleIdentifier') !== 'com.buddylab.desktop') throw issue('Target bundle identifier is not BuddyLab');
  const executable = await plist(infoFile, 'Print :CFBundleExecutable'); if (executable !== 'BuddyLab') throw issue('Unexpected desktop executable');
  const signature = (await command('/usr/bin/codesign', ['-dv', '--verbose=2', appPath])).stderr;
  if (!signature.includes('Info.plist=not bound') || !signature.includes('Sealed Resources=none')) throw issue('Target Info.plist/resources are sealed. Use a proper signed rebuild instead of an in-place code update.');
  if (apply) await assertNotRunning(appPath, executable);
  version ||= JSON.parse(await fs.readFile(path.join(sourceRoot, 'package.json'), 'utf8')).version;
  const executableFile = path.join(appPath, 'Contents/MacOS', executable), executableSha256 = await shaFile(executableFile);
  const oldAsarSha256 = await shaFile(archive), oldPlistSha256 = await shaFile(infoFile), oldHeaderSha256 = digest(asar.getRawHeader(archive).headerString);
  let embeddedHash; try { embeddedHash = await plist(infoFile, 'Print :ElectronAsarIntegrity:Resources/app.asar:hash'); } catch {}
  if (embeddedHash && embeddedHash !== oldHeaderSha256) throw issue('Existing ElectronAsarIntegrity disagrees with the archive header');
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'buddylab-existing-update-'));
  try {
    const built = await buildExistingAsarCandidate({ archive, sourceRoot, version, temporary }), nextPlist = path.join(temporary, 'Info.plist');
    await fs.copyFile(infoFile, nextPlist); await plist(nextPlist, `Set :CFBundleShortVersionString ${version}`); await plist(nextPlist, `Set :CFBundleVersion ${version}`);
    if (embeddedHash) await plist(nextPlist, `Set :ElectronAsarIntegrity:Resources/app.asar:hash ${built.newHeaderSha256}`);
    const report = { schemaVersion: 1, appPath, applied: false, previousVersion: built.previousVersion, version, oldAsarSha256, oldPlistSha256, oldHeaderSha256, executableSha256, unsealedLocalBuildVerified: true, newAsarSha256: await shaFile(built.candidate), newPlistSha256: await shaFile(nextPlist), newHeaderSha256: built.newHeaderSha256, integrityMetadataUpdated: Boolean(embeddedHash), publicFilesVerified: built.publicFiles, dependencyFilesPreserved: built.preservedFiles, unpackedFilesPreserved: built.preservedUnpackedFiles, personalDataBundled: false, originalExecutableChanged: false, chromiumChanged: false };
    if (!apply) return report;
    await assertNotRunning(appPath, executable);
    if (await shaFile(archive) !== oldAsarSha256 || await shaFile(infoFile) !== oldPlistSha256) throw issue('Target changed during preparation');
    const backup = path.join(backupRoot, `${Date.now()}-${built.previousVersion}-to-${version}`); await fs.mkdir(backup, { recursive: true, mode: 0o700 });
    await fs.copyFile(archive, path.join(backup, 'app.asar')); await fs.copyFile(infoFile, path.join(backup, 'Info.plist')); await fs.writeFile(path.join(backup, 'before.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
    try {
      await atomicCopy(built.candidate, archive); await atomicCopy(nextPlist, infoFile); asar.uncache(archive);
      if (await shaFile(archive) !== report.newAsarSha256 || await shaFile(infoFile) !== report.newPlistSha256 || digest(asar.getRawHeader(archive).headerString) !== built.newHeaderSha256 || await shaFile(executableFile) !== executableSha256) throw issue('Installed update verification failed');
    } catch (error) { await atomicCopy(path.join(backup, 'app.asar'), archive); await atomicCopy(path.join(backup, 'Info.plist'), infoFile); asar.uncache(archive); throw error; }
    report.applied = true; report.backup = backup; await fs.writeFile(path.join(backup, 'after.json'), JSON.stringify(report, null, 2), { mode: 0o600 }); return report;
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
}
export async function restoreExistingDesktop({ backup, appPath }) {
  const record = JSON.parse(await fs.readFile(path.join(backup, 'before.json'), 'utf8')); appPath = await fs.realpath(appPath);
  if (record.appPath !== appPath) throw issue('Backup belongs to another app path');
  await assertNotRunning(appPath, 'BuddyLab');
  if (await shaFile(path.join(backup, 'app.asar')) !== record.oldAsarSha256 || await shaFile(path.join(backup, 'Info.plist')) !== record.oldPlistSha256) throw issue('Backup checksum mismatch');
  await atomicCopy(path.join(backup, 'app.asar'), path.join(appPath, 'Contents/Resources/app.asar')); await atomicCopy(path.join(backup, 'Info.plist'), path.join(appPath, 'Contents/Info.plist')); asar.uncache(path.join(appPath, 'Contents/Resources/app.asar'));
  return { restored: true, appPath, version: record.previousVersion };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), options = {};
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--apply') { options.apply = true; continue; }
    if (!['--app', '--source', '--version', '--backup-root', '--restore'].includes(args[index]) || !args[index + 1]) throw issue('Usage: --app <existing BuddyLab.app> [--source <project>] [--version x.y.z] [--apply] [--restore <backup>]');
    const key = { '--app': 'appPath', '--source': 'sourceRoot', '--version': 'version', '--backup-root': 'backupRoot', '--restore': 'backup' }[args[index]]; options[key] = args[++index];
  }
  if (!options.appPath) throw issue('An explicit existing app path is required');
  console.log(JSON.stringify(options.backup ? await restoreExistingDesktop(options) : await updateExistingDesktop(options), null, 2));
}
