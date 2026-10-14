function createWakeController(powerSaveBlocker) {
  let id = null;
  const supported = Boolean(powerSaveBlocker && ['start', 'stop', 'isStarted'].every(name => typeof powerSaveBlocker[name] === 'function'));
  const state = () => ({ supported, enabled: supported && id !== null && powerSaveBlocker.isStarted(id), mode: 'prevent-app-suspension' });
  function set(enabled) {
    if (typeof enabled !== 'boolean') throw new TypeError('Keep awake requires a boolean');
    if (!supported) throw new Error('System sleep control unavailable');
    if (enabled && !state().enabled) id = powerSaveBlocker.start('prevent-app-suspension');
    if (!enabled && id !== null) { powerSaveBlocker.stop(id); id = null; }
    return state();
  }
  return { state, set, close: () => { if (supported) set(false); } };
}
module.exports = { createWakeController };
