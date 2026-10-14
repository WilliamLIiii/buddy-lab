const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { baseURL } = require('./security.cjs');

function validatePreferences(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['dataDir', 'workspaceRoot', 'connectURL'].includes(key))) throw new Error('Invalid desktop preferences');
  const result = {};
  for (const key of ['dataDir', 'workspaceRoot']) if (value[key] !== undefined) {
    if (typeof value[key] !== 'string' || !value[key] || value[key].length > 4000 || !path.isAbsolute(value[key])) throw new Error('Invalid desktop directory');
    result[key] = path.resolve(value[key]);
  }
  if (value.connectURL !== undefined) result.connectURL = baseURL(value.connectURL);
  return result;
}
async function readPreferences(userData) {
  try { return validatePreferences(JSON.parse(await fs.readFile(path.join(userData, 'desktop-preferences.json'), 'utf8'))); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw new Error('Desktop preferences unavailable or invalid'); }
}
async function savePreferences(userData, value) {
  const preferences = validatePreferences(value), file = path.join(userData, 'desktop-preferences.json'), temporary = `${file}.${randomUUID()}.tmp`;
  await fs.mkdir(userData, { recursive: true, mode: 0o700 });
  try { await fs.writeFile(temporary, JSON.stringify(preferences, null, 2), { flag: 'wx', mode: 0o600 }); await fs.rename(temporary, file); }
  finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
  return preferences;
}
function resolvePreferences(saved, { args = {}, env = process.env, userData, documents } = {}) {
  return validatePreferences({ dataDir: args.dataDir || env.BUDDYLAB_DATA_DIR || saved.dataDir || path.join(userData, 'data'),
    workspaceRoot: args.workspaceRoot || env.BUDDYLAB_WORKSPACE_ROOT || saved.workspaceRoot || path.join(documents, 'BuddyLab 工作区'),
    connectURL: args.connectURL || env.BUDDYLAB_DESKTOP_URL || saved.connectURL || 'http://127.0.0.1:47831/' });
}
module.exports = { validatePreferences, readPreferences, savePreferences, resolvePreferences };
