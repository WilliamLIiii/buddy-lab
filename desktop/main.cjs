const { app, BrowserWindow, ipcMain, dialog, Menu, Tray, nativeImage, shell, utilityProcess, safeStorage, powerSaveBlocker } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { baseURL, isAppPage, isDownload, isTrustedIPC, externalURL } = require('./security.cjs');
const { createDesktopSecretStore } = require('./secure-storage.cjs');
const { readPreferences, savePreferences, resolvePreferences } = require('./preferences.cjs');
const { settingsTab, navigation } = require('./navigation.cjs');
const { createWakeController } = require('./power-save.cjs');
const wakeController = createWakeController(powerSaveBlocker);
app.setName('BuddyLab');
let window, settingsWindow, tray, backend, quitting = false, stopping = false, info, preferences;
const argument = name => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; };
const forceOwned = process.argv.includes('--own-backend');
if (process.env.BUDDYLAB_DESKTOP_USER_DATA) app.setPath('userData', path.resolve(process.env.BUDDYLAB_DESKTOP_USER_DATA));
const isPrimary = app.requestSingleInstanceLock();
if (!isPrimary) app.quit();
app.on('second-instance', () => { window?.show(); window?.focus(); });

async function inspectExisting(value) {
  const url = baseURL(value);
  try {
    const response = await fetch(new URL('api/health', url), { signal: AbortSignal.timeout(1800) });
    if (response.ok) { const result = await response.json(); if (result.product === 'buddy-lab' && result.apiVersion === 1) return url; }
    const html = await fetch(url, { signal: AbortSignal.timeout(1800) }).then(response => response.text());
    if (/<meta\s+name=["']application-name["']\s+content=["']BuddyLab["']/i.test(html)) return url;
  } catch {}
  return null;
}
function packagedBrowser() {
  if (!app.isPackaged) return undefined;
  const browser = require('../desktop/runtime.json');
  return path.join(process.resourcesPath, 'playwright-browsers', browser.directory, ...browser.executable);
}
async function startOwned() {
  const { dataDir, workspaceRoot } = preferences;
  const helper = app.isPackaged && process.platform === 'darwin' ? path.join(process.resourcesPath, 'helpers', 'buddylab-keychain') : undefined;
  if (helper) process.env.BUDDYLAB_KEYCHAIN_HELPER = helper;
  const { createKeychainStore } = await import(require('node:url').pathToFileURL(path.join(__dirname, '../src/credentials.mjs')).href);
  const secrets = createDesktopSecretStore({ safeStorage, dataDir, legacyStore: process.platform === 'darwin' ? createKeychainStore(dataDir) : undefined });
  const chromiumPath = packagedBrowser();
  const env = Object.fromEntries(['PATH', 'HOME', 'LANG', 'TMPDIR', 'SYSTEMROOT', 'SystemRoot', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'BUDDYLAB_API_KEY', 'BUDDYLAB_BASE_URL', 'BUDDYLAB_MODEL'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
  if (app.isPackaged) env.PLAYWRIGHT_BROWSERS_PATH = path.join(process.resourcesPath, 'playwright-browsers');
  if (helper) env.BUDDYLAB_KEYCHAIN_HELPER = helper;
  backend = utilityProcess.fork(path.join(__dirname, 'backend.cjs'), [], { env, stdio: 'pipe', serviceName: 'BuddyLab Backend', allowLoadingUnsignedLibraries: process.platform === 'darwin' });
  backend.stdout?.resume(); backend.stderr?.resume();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Backend startup timed out')), 30000);
    backend.on('message', async message => {
      if (message?.type === 'secret-request' && ['get', 'set', 'delete'].includes(message.operation)) {
        try { const value = await secrets[message.operation](message.value); backend?.postMessage({ type: 'secret-response', id: message.id, ok: true, value }); }
        catch { backend?.postMessage({ type: 'secret-response', id: message.id, ok: false }); }
      } else if (message?.type === 'ready') { clearTimeout(timer); resolve({ owned: true, url: baseURL(message.url), runtime: message.runtime }); }
      else if (message?.type === 'startup-failed') { clearTimeout(timer); reject(new Error('Backend startup failed')); }
    });
    backend.once('exit', () => { clearTimeout(timer); if (!quitting) reject(new Error('Backend stopped')); });
    backend.postMessage({ type: 'initialize', dataDir, workspaceRoot, chromiumPath });
  });
}
async function openExternal(value) {
  let url; try { url = externalURL(value); } catch { return; }
  if (info && new URL(url).origin === new URL(info.url).origin) return;
  const result = await dialog.showMessageBox(window, { type: 'question', title: '打开外部网站', message: `使用系统浏览器打开 ${new URL(url).origin}？`, buttons: ['取消', '打开'], defaultId: 0, cancelId: 0 });
  if (result.response === 1) await shell.openExternal(url);
}
function showWindow() { if (window?.isMinimized()) window.restore(); window?.show(); window?.focus(); }
function callerWindow(event) { return [window, settingsWindow].find(candidate => isTrustedIPC(event, candidate, info.url)); }
function registeredContents(contents) { return [window, settingsWindow].some(candidate => candidate && !candidate.isDestroyed() && candidate.webContents === contents); }
function windowSecurity(target) {
  target.webContents.on('will-attach-webview', event => event.preventDefault());
  target.webContents.on('will-navigate', (event, url) => { if (!isAppPage(url, info.url) && !isDownload(url, info.url)) { event.preventDefault(); openExternal(url).catch(() => {}); } });
  target.webContents.setWindowOpenHandler(({ url }) => { openExternal(url).catch(() => {}); return { action: 'deny' }; });
}
async function openSettings(value = 'models') {
  const tab = settingsTab(value), url = new URL(info.url); url.searchParams.set('surface', 'settings'); url.searchParams.set('tab', tab);
  if (settingsWindow && !settingsWindow.isDestroyed()) { if (settingsWindow.webContents.getURL() !== url.href) await settingsWindow.loadURL(url.href); settingsWindow.show(); settingsWindow.focus(); return { opened: true, tab }; }
  settingsWindow = new BrowserWindow({ title: 'BuddyLab 设置', width: 900, height: 680, minWidth: 740, minHeight: 560, show: false, type: 'utility', backgroundColor: '#f7fcff',
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 14 } } : {}),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false, webSecurity: true, allowRunningInsecureContent: false, webviewTag: false }
  });
  const current = settingsWindow; windowSecurity(current); current.once('ready-to-show', () => { if (!current.isDestroyed()) { current.show(); current.focus(); } }); current.once('closed', () => { if (settingsWindow === current) settingsWindow = undefined; }); await current.loadURL(url.href); return { opened: true, tab };
}
async function chooseBackendDirectories() {
  const data = await dialog.showOpenDialog(window, { title: '选择 BuddyLab 数据目录（包含 buddylab.sqlite，可选择原项目 .data）', defaultPath: preferences.dataDir, properties: ['openDirectory', 'createDirectory'] });
  if (data.canceled || !data.filePaths[0]) return;
  const workspace = await dialog.showOpenDialog(window, { title: '选择默认工作区目录', defaultPath: preferences.workspaceRoot, properties: ['openDirectory', 'createDirectory'] });
  if (workspace.canceled || !workspace.filePaths[0]) return;
  const next = { ...preferences, dataDir: await fs.realpath(data.filePaths[0]), workspaceRoot: await fs.realpath(workspace.filePaths[0]) };
  await savePreferences(app.getPath('userData'), next);
  await dialog.showMessageBox(window, { type: 'info', title: '数据目录已保存', message: '设置将在下次启动时生效。现有数据库、历史记录和工作区文件保留在原目录。若本地 BuddyLab 服务正在运行，客户端会优先连接它。' });
}
function createWindow() {
  window = new BrowserWindow({ title: 'BuddyLab', width: 1360, height: 900, minWidth: 900, minHeight: 640, show: false, backgroundColor: '#f7f9fc',
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 14 } } : {}),
    icon: path.join(__dirname, 'assets/icon.png'), webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true,
      nodeIntegration: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false, webSecurity: true, allowRunningInsecureContent: false, webviewTag: false }
  });
  window.webContents.session.setPermissionRequestHandler((contents, permission, callback) => callback(registeredContents(contents) && isAppPage(contents.getURL(), info.url) && permission === 'clipboard-sanitized-write'));
  window.webContents.session.setPermissionCheckHandler((contents, permission, origin) => registeredContents(contents) && origin === new URL(info.url).origin && permission === 'clipboard-sanitized-write');
  window.webContents.session.webRequest.onHeadersReceived({ urls: [info.url + '*'] }, (details, callback) => {
    const headers = { ...details.responseHeaders };
    if (details.resourceType === 'mainFrame') headers['Content-Security-Policy'] = ["default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'none'"];
    callback({ responseHeaders: headers });
  });
  windowSecurity(window);
  window.on('close', event => { if (!quitting) { event.preventDefault(); window.hide(); } });
  window.once('ready-to-show', showWindow); window.loadURL(info.url);
}
function installIPC() {
  ipcMain.handle('buddy:keep-awake', event => { if (!callerWindow(event)) throw new Error('Untrusted desktop caller'); return wakeController.state(); });
  ipcMain.handle('buddy:set-keep-awake', (event, enabled) => { if (!callerWindow(event)) throw new Error('Untrusted desktop caller'); return wakeController.set(enabled); });
  ipcMain.handle('buddy:runtime', event => {
    if (!callerWindow(event)) throw new Error('Untrusted desktop caller');
    return { desktop: true, platform: process.platform, arch: process.arch, version: app.getVersion(), electron: process.versions.electron, node: process.versions.node,
      backend: { owned: info.owned, url: info.url }, dataDirectory: preferences.dataDir, workspaceDirectory: preferences.workspaceRoot,
      secureStorage: ['darwin', 'win32'].includes(process.platform) ? process.platform === 'darwin' ? 'keychain' : 'dpapi' : 'unavailable', nativeRuntime: info.runtime || null };
  });
  ipcMain.handle('buddy:choose-directory', async (event, options) => {
    const owner = callerWindow(event); if (!owner) throw new Error('Untrusted desktop caller');
    if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => key !== 'defaultPath') || options.defaultPath !== undefined && (typeof options.defaultPath !== 'string' || options.defaultPath.length > 4000 || !path.isAbsolute(options.defaultPath))) throw new Error('Invalid directory options');
    const result = await dialog.showOpenDialog(owner, { title: '选择工作区文件夹', properties: ['openDirectory', 'createDirectory'], ...(options.defaultPath ? { defaultPath: options.defaultPath } : {}) });
    return result.canceled || !result.filePaths[0] ? null : fs.realpath(result.filePaths[0]);
  });
  ipcMain.handle('buddy:open-settings', (event, value) => { if (!callerWindow(event)) throw new Error('Untrusted desktop caller'); return openSettings(value); });
  ipcMain.handle('buddy:close-settings', event => { if (!callerWindow(event)) throw new Error('Untrusted desktop caller'); const target = settingsWindow; if (!target || target.isDestroyed()) return { closed: false }; setImmediate(() => { if (!target.isDestroyed()) target.close(); }); return { closed: true }; });
  ipcMain.handle('buddy:show-main-view', (event, value) => { if (!callerWindow(event)) throw new Error('Untrusted desktop caller'); const target = navigation(value); showWindow(); window.webContents.send('buddy:navigate', target); return { shown: true, ...target }; });
}
function installMenu() {
  const application = [{ label: '打开 BuddyLab', click: showWindow }, { label: '设置…', accelerator: process.platform === 'darwin' ? 'Cmd+,' : 'Ctrl+,', click: () => openSettings().catch(() => {}) }, { label: '本地数据目录…', click: () => chooseBackendDirectories().catch(() => dialog.showMessageBox(window, { type: 'error', message: '无法保存数据目录设置。' })) }, { type: 'separator' }, { label: '退出 BuddyLab', accelerator: process.platform === 'darwin' ? 'Cmd+Q' : 'Alt+F4', click: () => app.quit() }];
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: 'BuddyLab', submenu: application }, { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] }, { label: '视图', submenu: [{ role: 'reload' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }] }]));
  const icon = nativeImage.createFromPath(path.join(__dirname, 'assets/icon.png')).resize({ width: 18, height: 18 });
  tray = new Tray(icon); tray.setToolTip('BuddyLab - 关闭窗口后定时任务继续运行'); tray.setContextMenu(Menu.buildFromTemplate(application)); tray.on('click', showWindow);
}
app.on('activate', showWindow); app.on('window-all-closed', () => {});
app.on('before-quit', event => {
  quitting = true;
  wakeController.close();
  if (!backend || stopping) return;
  event.preventDefault(); stopping = true;
  const owned = backend; const timer = setTimeout(() => { owned.kill(); backend = null; app.quit(); }, 15000);
  owned.once('exit', () => { clearTimeout(timer); backend = null; app.quit(); }); owned.postMessage({ type: 'shutdown' });
});
if (isPrimary) app.whenReady().then(async () => {
  const saved = await readPreferences(app.getPath('userData'));
  preferences = resolvePreferences(saved, { args: { dataDir: argument('--data-dir'), workspaceRoot: argument('--workspace-root'), connectURL: argument('--connect-url') }, userData: app.getPath('userData'), documents: app.getPath('documents') });
  if (argument('--data-dir') || argument('--workspace-root') || argument('--connect-url') || process.env.BUDDYLAB_DATA_DIR || process.env.BUDDYLAB_WORKSPACE_ROOT || process.env.BUDDYLAB_DESKTOP_URL) await savePreferences(app.getPath('userData'), preferences);
  if (!forceOwned) { const url = await inspectExisting(preferences.connectURL); if (url) info = { owned: false, url }; else if (argument('--connect-url') || process.env.BUDDYLAB_DESKTOP_URL) throw new Error('Trusted BuddyLab backend unavailable'); }
  info ??= await startOwned(); installIPC(); createWindow(); installMenu();
}).catch(async () => { await dialog.showMessageBox({ type: 'error', title: 'BuddyLab 启动失败', message: '无法启动本地工作台。请检查客户端运行环境和本地服务；没有改动原应用。' }); app.quit(); });
