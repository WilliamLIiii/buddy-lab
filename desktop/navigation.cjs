const tabs = new Set(['models', 'general', 'profile', 'appearance', 'execution', 'memory', 'data', 'about', 'shortcuts', 'assistant-settings', 'application-settings']);
const views = new Set(['task', 'assistants', 'apps', 'capabilities', 'library', 'automations']);
function settingsTab(value = 'models') { if (typeof value !== 'string' || !tabs.has(value)) throw new Error('Unsupported settings tab'); return value; }
function navigation(value) {
  const input = typeof value === 'string' ? { view: value } : value;
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['view', 'tab'].includes(key)) || !views.has(input.view) || input.tab !== undefined && (input.view !== 'capabilities' || !['experts', 'skills', 'connectors'].includes(input.tab))) throw new Error('Unsupported main navigation');
  return { view: input.view, ...(input.tab ? { tab: input.tab } : {}) };
}
module.exports = { settingsTab, navigation };
