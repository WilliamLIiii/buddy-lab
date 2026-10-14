import { _electron } from 'playwright';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createDesktopFixture } from './desktop-skill-fixture.mjs';
import { executeDocumentTool } from '../src/documents.mjs';
import { inspectDesktopProcesses } from './desktop-process-identity.mjs';
const root = fileURLToPath(new URL('../', import.meta.url)), require = createRequire(import.meta.url), temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'buddylab-desktop-smoke-'));
const packaged = process.argv.find(item => item.startsWith('--executable='))?.slice('--executable='.length), executablePath = packaged || require('electron');
const args = packaged ? [] : [root], output = path.join(root, 'output/desktop'); await fs.mkdir(output, { recursive: true });
const env = { ...process.env, BUDDYLAB_API_KEY: '', BUDDYLAB_BASE_URL: '', BUDDYLAB_MODEL: '', BUDDYLAB_WORKSPACE_ROOT: path.join(temporary, 'workspace') }; delete env.ELECTRON_RUN_AS_NODE;
let application, fixture;
try {
  application = await _electron.launch({ executablePath, args: [...args, '--own-backend', '--data-dir', path.join(temporary, 'data')],
    env: { ...env, BUDDYLAB_DESKTOP_USER_DATA: path.join(temporary, 'user') }, timeout: 90000 });
  const page = await application.firstWindow({ timeout: 90000 }); await page.waitForFunction(() => Boolean(window.buddyDesktop && document.querySelector('#app')), undefined, { timeout: 90000 });
  const runtime = await page.evaluate(() => window.buddyDesktop.runtime());
  const reportName = packaged ? runtime.arch === 'x64' && runtime.platform === 'darwin' ? 'packaged-intel-smoke' : 'packaged-smoke' : 'development-smoke';
  if (!runtime.backend.owned || !runtime.nativeRuntime?.sqlite || !runtime.nativeRuntime.sharp || !runtime.nativeRuntime.canvas) throw new Error('Owned Electron backend/native runtime did not start');
  const isolation = await page.evaluate(() => ({ requireAbsent: typeof require === 'undefined', processAbsent: typeof process === 'undefined', api: Object.keys(window.buddyDesktop).sort() }));
  const nativeSettingsSupported = isolation.api.includes('openSettings');
  if (!isolation.requireAbsent || !isolation.processAbsent || isolation.api.join(',') !== (nativeSettingsSupported ? 'chooseDirectory,closeSettings,onNavigate,openSettings,runtime,showMainView' : 'chooseDirectory,runtime')) throw new Error('Renderer isolation failed');
  let nativeSettingsRuntime = null, processGuardRuntime = null;
  if (packaged) { const state = await inspectDesktopProcesses({ appPath: path.resolve(executablePath, '../../..') }); if (state.status !== 'active' || !state.active.some(row => row.executable === path.resolve(executablePath))) throw new Error('Actual packaged app executable was not independently verified'); processGuardRuntime = { method: state.method, actualExecutableVerifiedDuringRun: true, commandTextUsedAsIdentity: false }; }
  if (nativeSettingsSupported) {
    const opened = application.waitForEvent('window'); await page.evaluate(() => window.buddyDesktop.openSettings('models')); const settings = await opened;
    await settings.waitForFunction(() => Boolean(window.buddyDesktop));
    if (new URL(settings.url()).searchParams.get('surface') !== 'settings' || new URL(settings.url()).searchParams.get('tab') !== 'models') throw new Error('Native settings surface route incorrect');
    const size = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => new URL(window.webContents.getURL()).searchParams.get('surface') === 'settings').getSize());
    if (size[0] !== 900 || size[1] !== 680) throw new Error('Native settings geometry incorrect');
    const ownRuntime = await settings.evaluate(() => window.buddyDesktop.runtime()); if (ownRuntime.backend.url !== runtime.backend.url) throw new Error('Settings backend was duplicated');
    const rogueOpened = application.waitForEvent('window');
    const rogueId = await application.evaluate(({ app, BrowserWindow }, url) => { const rogue = new BrowserWindow({ show: false, webPreferences: { preload: app.getAppPath() + '/desktop/preload.cjs', contextIsolation: true, sandbox: true, nodeIntegration: false } }); void rogue.loadURL(url); return rogue.id; }, ownRuntime.backend.url);
    const rogue = await rogueOpened; await rogue.waitForFunction(() => Boolean(window.buddyDesktop));
    const denied = await rogue.evaluate(() => window.buddyDesktop.runtime().then(() => false, error => String(error.message).includes('Untrusted desktop caller')));
    await application.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)?.destroy(), rogueId);
    if (!denied) throw new Error('Unregistered same-origin native window obtained IPC capability');
    await page.evaluate(() => window.buddyDesktop.openSettings('general'));
    if ((await application.windows()).length !== 2) throw new Error('Repeated settings created duplicate native windows');
    await settings.waitForFunction(() => Boolean(window.buddyDesktop));
    await page.evaluate(() => { window.__nativeNavFixture = null; window.__nativeNavUnsubscribe = window.buddyDesktop.onNavigate(value => { window.__nativeNavFixture = value; }); });
    await settings.evaluate(() => window.buddyDesktop.showMainView({ view: 'capabilities', tab: 'connectors' }));
    await page.waitForFunction(() => window.__nativeNavFixture?.view === 'capabilities' && window.__nativeNavFixture.tab === 'connectors');
    await assertInvalidSettings(settings);
    await page.evaluate(() => window.__nativeNavUnsubscribe());
    const closed = settings.waitForEvent('close'); await page.evaluate(() => window.buddyDesktop.closeSettings()); await closed;
    nativeSettingsRuntime = { utility900x680: true, sameOwnedBackend: true, onlyRegisteredSettingsCallerAllowed: true, repeatedOpenReusedWindow: true, typedMainNavigationDelivered: true, invalidNavigationRejected: true, closeDestroyedUtility: true };
  }
  await application.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, temporary);
  const chosen = await page.evaluate(selected => window.buddyDesktop.chooseDirectory({ defaultPath: selected }), temporary);
  if (chosen !== await fs.realpath(temporary)) throw new Error('Native directory IPC failed');
  fixture = await createDesktopFixture();
  const dummy = 'desktop-fixture-not-a-real-key';
  const saved = await fetch(new URL('api/config', runtime.backend.url), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: 'openai', baseURL: fixture.baseURL, model: 'fixture-local-only', apiKey: dummy }) }).then(response => response.json());
  if (!saved.hasApiKey || saved.keyStorage !== 'os-encrypted' || !saved.keyPersistent) throw new Error('Real OS secure storage was unavailable');
  const encryptedDir = path.join(temporary, 'data/credentials'), cipherFile = (await fs.readdir(encryptedDir))[0];
  if ((await fs.readFile(path.join(encryptedDir, cipherFile))).includes(Buffer.from(dummy))) throw new Error('Plaintext found in secure storage');
  let backendURL = runtime.backend.url;
  const request = async (route, data) => {
    const response = await fetch(new URL(route, backendURL), { method: data === undefined ? 'GET' : 'POST', ...(data === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }) });
    const result = await response.json(); if (!response.ok) throw new Error(`Desktop fixture route failed: ${route}: ${JSON.stringify(result.error)}`); return result;
  };
  const initialBootstrap = await request('api/bootstrap'), workspace = initialBootstrap.workspaces[0];
  let nativeImportRuntime = null;
  if (['0.4.1', '0.4.2', '0.4.3'].includes(runtime.version)) {
    if (initialBootstrap.expertCatalog?.native?.total !== 0 || initialBootstrap.expertCatalog.native.agents !== 0 || initialBootstrap.expertCatalog.native.skills !== 0) throw new Error('Personal native experts were unexpectedly bundled or native support absent');
    const source = path.join(temporary, 'native-fixture-source'), plugin = path.join(source, 'native-fixture');
    for (const directory of ['.codebuddy-plugin', 'agents', 'skills/fixture-guide/references']) await fs.mkdir(path.join(plugin, directory), { recursive: true });
    await fs.writeFile(path.join(plugin, '.codebuddy-plugin/plugin.json'), JSON.stringify({ name: 'native-fixture', version: '1.0.0', expertType: 'agent', agentName: 'fixture-agent', displayName: { zh: 'Fixture 专家' }, agents: ['./agents/fixture-agent.md'], skills: ['./skills/fixture-guide'] }));
    await fs.writeFile(path.join(plugin, 'agents/fixture-agent.md'), '---\nname: fixture-agent\nskills: [fixture-guide]\n---\nPACKAGED_NATIVE_ROLE_FULL_END');
    await fs.writeFile(path.join(plugin, 'skills/fixture-guide/SKILL.md'), '---\nname: Fixture Guide\ndescription: Protocol fixture only\n---\nPACKAGED_NATIVE_SKILL_FULL_END');
    await fs.writeFile(path.join(plugin, 'skills/fixture-guide/references/detail.md'), 'PACKAGED_NATIVE_REFERENCE_FULL_END');
    const imported = await request('api/experts/import-workbuddy', { path: source });
    if (imported.agents !== 1 || imported.skills !== 1 || imported.scriptsExecuted !== false) throw new Error('Packaged local native import failed');
    const role = await request('api/experts/' + encodeURIComponent('workbuddy:native-fixture:fixture-agent'));
    if (!role.instructions.includes('PACKAGED_NATIVE_ROLE_FULL_END') || role.requiredSkills[0] !== 'workbuddy-skill:native-fixture:fixture-guide') throw new Error('Packaged complete native role/dependency load failed');
    nativeImportRuntime = { emptyNativeCatalogAtFirstStart: true, pureLocalFixtureImported: true, fullRoleInstructionsLoaded: true, scopedRequiredSkillResolved: true, sourceScriptsExecuted: false, personalExpertFilesBundled: false };
  }
  await executeDocumentTool('create_xlsx', { path: 'artifacts/source.xlsx', sheets: [{ name: 'Fixture', rows: [['Item', 'Amount'], ['Budget', 12000]] }] }, { root: workspace.root });
  await fs.rename(path.join(workspace.root, 'artifacts/source.xlsx'), path.join(workspace.root, 'source.xlsx'));
  const runTools = async prompt => {
    const session = await request('api/sessions', { workspaceId: workspace.id, mode: 'AGENT' });
    await request(`api/sessions/${session.id}/prompts`, { text: prompt });
    const approvals = new Set(), started = Date.now(), budget = runtime.arch !== process.arch ? 180000 : 45000;
    while (Date.now() - started < budget) {
      const detail = await request(`api/sessions/${session.id}`);
      for (const event of detail.events.filter(item => item.type === 'approval')) if (!approvals.has(event.payload.id)) {
        approvals.add(event.payload.id); await request(`api/approvals/${event.payload.id}`, { approved: true });
      }
      if (['COMPLETED', 'FAILED', 'CANCELLED', 'DECLINED'].includes(detail.run?.status)) {
        if (detail.run.status !== 'COMPLETED' || detail.events.some(item => item.type === 'tool_done' && item.payload.isError)) throw new Error('Packaged tool workflow failed: ' + JSON.stringify({ status: detail.run.status, errors: detail.events.filter(item => item.type === 'tool_done' && item.payload.isError).map(item => ({ name: item.payload.name, result: item.payload.result })) }));
        return detail;
      }
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    throw new Error('Packaged tool workflow timed out');
  };
  let skillManagementRuntime = null, managedSkill, taskProgressRuntime = null, progressSessionId;
  if (['0.4.2', '0.4.3'].includes(runtime.version)) {
    const created = await runTools('DESKTOP_SKILL_CREATE'), modified = await runTools('DESKTOP_SKILL_MODIFY');
    const done = (detail, name) => detail.events.filter(event => event.type === 'tool_done' && event.payload.name === name).at(-1)?.payload.result;
    const first = done(created, 'SkillManage'), second = done(modified, 'SkillManage'), loaded = done(modified, 'load_skill');
    if (!first?.created || first.scriptsExecuted !== false || second?.created !== false || second.version !== 2 || first.hash === second.hash || !JSON.stringify(loaded).includes('DESKTOP_REAL_SKILL_V2_FULL_END')) throw new Error('Packaged SkillManage create/modify/load roundtrip failed');
    if (created.events.filter(event => event.type === 'approval').length !== 1 || modified.events.filter(event => event.type === 'approval').length !== 1) throw new Error('SkillManage mutations bypassed actual approval');
    if (!loaded.managed || loaded.hash !== second.hash) throw new Error('Packaged managed skill did not return paired actual hash');
    managedSkill = second;
    skillManagementRuntime = { createApproved: true, modifyApproved: true, actualFileCreated: true, completeUpdatedInstructionsLoaded: true, managedHashPairedWithBody: true, scriptsExecuted: false };
    const planned = await runTools('DESKTOP_TASK_PROGRESS'), progress = await request(`api/sessions/${planned.session.id}/tasks`);
    if (progress.version !== 3 || progress.tasks.length !== 1 || progress.tasks[0].status !== 'completed' || ['TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList'].some(name => !planned.events.some(event => event.type === 'tool_done' && event.payload.name === name)) || !planned.events.some(event => event.type === 'tool_done' && event.payload.name === 'read_document' && JSON.stringify(event.payload.result).includes('12000'))) throw new Error('Packaged task progress primitives or actual result evidence failed');
    progressSessionId = planned.session.id;
    taskProgressRuntime = { fourPrimitivesCalled: true, actualWorkbookReadBeforeCompleted: true, sqliteProgressVersion: progress.version };
  }
  const browser = await runTools('UI_BROWSER');
  if (!browser.events.some(item => item.type === 'tool_done' && item.payload.name === 'browser_navigate' && JSON.stringify(item.payload.result).includes('真实网页资料'))) throw new Error('Packaged browser returned no real page');
  const screenshot = browser.artifacts.find(item => item.path.endsWith('.png'));
  const pixels = Buffer.from(await (await fetch(new URL(`api/artifacts/${screenshot.id}?download=1`, runtime.backend.url))).arrayBuffer());
  if (pixels.toString('hex', 0, 8) !== '89504e470d0a1a0a') throw new Error('Packaged browser screenshot invalid');
  const office = await runTools('UI_DOCS');
  if (office.artifacts.length !== 4) throw new Error('Packaged Office artifacts missing');
  const pdf = office.artifacts.find(item => item.path.endsWith('.pdf'));
  const preview = await request(`api/artifacts/${pdf.id}`); if (!JSON.stringify(preview).includes('12000')) throw new Error('Packaged PDF generation/extraction failed');
  for (const artifact of office.artifacts) {
    const response = await fetch(new URL(`api/artifacts/${artifact.id}?download=1`, runtime.backend.url)), bytes = Buffer.from(await response.arrayBuffer());
    if (!response.ok || bytes.length < 100 || !(bytes.toString('ascii', 0, 4) === '%PDF' || bytes.toString('ascii', 0, 2) === 'PK')) throw new Error('Packaged Office binary download failed');
  }
  const toolRuntime = { browserNavigation: true, browserFillAndClick: true, screenshotPixels: true, pdfCreatedAndRead: true, pdfExtractedCharacters: (preview.text || preview.content).length, pdfExpectedActualTextFound: (preview.text || preview.content).includes('12000'), fourOfficeFormatsCreatedAndDownloaded: true, bundledBrowser: Boolean(packaged), nativeImportRuntime, skillManagementRuntime, taskProgressRuntime, modelFixture: 'isolated localhost protocol fixture' };
  await fs.writeFile(path.join(output, reportName + '.json'), JSON.stringify({ status: 'restart-validation-pending', platform: runtime.platform, arch: runtime.arch, hostArchitecture: process.arch, appVersion: runtime.version, electron: runtime.electron, nativeRuntime: runtime.nativeRuntime, rendererIsolation: isolation, encryptedAtRest: true, toolRuntime, commercialModelCalls: false }, null, 2));
  await page.screenshot({ path: path.join(output, packaged ? runtime.arch === 'x64' && runtime.platform === 'darwin' ? 'mac-intel-packaged-client.png' : 'mac-packaged-client.png' : 'mac-development-client.png') });
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  if (!(await fetch(new URL('api/health', runtime.backend.url))).ok) throw new Error('Closing window stopped the backend');
  await application.close(); application = null;
  const shutdown = await fetch(runtime.backend.url, { signal: AbortSignal.timeout(1000) }).then(() => false).catch(() => true);
  if (!shutdown) throw new Error('Owned backend was left running after Quit');
  application = await _electron.launch({ executablePath, args: [...args, '--own-backend', '--data-dir', path.join(temporary, 'data')], env: { ...env, BUDDYLAB_DESKTOP_USER_DATA: path.join(temporary, 'user') }, timeout: 90000 });
  const restarted = await application.firstWindow({ timeout: 90000 }); await restarted.waitForFunction(() => Boolean(window.buddyDesktop), undefined, { timeout: 90000 });
  const restartedRuntime = await restarted.evaluate(() => window.buddyDesktop.runtime());
  backendURL = restartedRuntime.backend.url;
  const bootstrap = await fetch(new URL('api/bootstrap', restartedRuntime.backend.url)).then(response => response.json());
  if (!bootstrap.config.hasApiKey || !bootstrap.config.keyPersistent) throw new Error('OS encrypted credentials did not survive restart');
  if (managedSkill) {
    const skills = await request(`api/skills?workspaceId=${encodeURIComponent(workspace.id)}`);
    if (!skills.skills.some(skill => skill.id === managedSkill.id)) throw new Error('Generated skill did not survive desktop restart discovery');
    const detail = await runTools('DESKTOP_SKILL_RESTART_LOAD'), loaded = detail.events.find(event => event.type === 'tool_done' && event.payload.name === 'load_skill')?.payload.result;
    if (!loaded?.managed || loaded.hash !== managedSkill.hash || !JSON.stringify(loaded).includes('DESKTOP_REAL_SKILL_V2_FULL_END')) throw new Error('Restarted skill load/body/hash failed');
    skillManagementRuntime.discoveredAndLoadedAfterRestart = true;
    const progress = await request(`api/sessions/${progressSessionId}/tasks`);
    if (progress.version !== 3 || progress.tasks[0]?.status !== 'completed') throw new Error('Packaged task progress was not restored after restart');
    taskProgressRuntime.restoredAfterRestart = true;
  }
  const report = { status: 'passed', platform: runtime.platform, arch: runtime.arch, hostArchitecture: process.arch, appVersion: runtime.version, electron: runtime.electron, node: runtime.node, nativeRuntime: runtime.nativeRuntime, rendererIsolation: isolation,
    nativeDirectoryBridge: true, nativeSettingsRuntime, processGuardRuntime, secureStorage: runtime.secureStorage, encryptedAtRest: true, secureRestoreAfterRestart: true, toolRuntime, windowCloseKeptBackend: true, quitStoppedOwnedBackend: true, commercialModelCalls: false, packaged: Boolean(packaged) };
  await fs.writeFile(path.join(output, reportName + '.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ desktopSmokePassed: true, packaged: Boolean(packaged), platform: runtime.platform, arch: runtime.arch }));
} finally { await application?.close().catch(() => {}); await fixture?.close().catch(() => {}); await fs.rm(temporary, { recursive: true, force: true }); }

async function assertInvalidSettings(page) {
  const denied = await page.evaluate(async () => { try { await window.buddyDesktop.showMainView({ view: 'task', url: 'file:///forbidden' }); return false; } catch { return true; } });
  if (!denied) throw new Error('Unexpected navigation fields were accepted');
}
