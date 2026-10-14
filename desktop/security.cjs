function baseURL(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Only an explicit loopback application URL is allowed');
  return url.origin + '/';
}
function isAppPage(value, base) {
  try { const url = new URL(value); return url.origin === new URL(base).origin && ['/', '/index.html'].includes(url.pathname); } catch { return false; }
}
function isDownload(value, base) {
  try { const url = new URL(value); return url.origin === new URL(base).origin && url.pathname.startsWith('/api/') && url.searchParams.get('download') === '1'; } catch { return false; }
}
function isTrustedIPC(event, window, base) {
  return Boolean(window && !window.isDestroyed() && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame && isAppPage(event.senderFrame.url, base));
}
function externalURL(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.href.length > 4000) throw new Error('Unsupported external URL');
  return url.href;
}
module.exports = { baseURL, isAppPage, isDownload, isTrustedIPC, externalURL };
