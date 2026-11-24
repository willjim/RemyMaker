const STORAGE_KEY = 'remymaker-professional-mode-v1';
const MAX_CLICK_GAP_MS = 1500;
const REQUIRED_CLICKS = 5;

/**
 * A local preference plus a short, uninterrupted title-click sequence.
 * Some browser contexts disable storage; activation still lasts for the page.
 */
export function createProfessionalMode({
  read = key => globalThis.localStorage.getItem(key),
  write = (key, value) => globalThis.localStorage.setItem(key, value),
} = {}) {
  let enabled = false;
  try {
    enabled = read(STORAGE_KEY) === '1';
  } catch (_) {
    // Storage is optional.
  }
  let clicks = 0;
  let lastClick = -Infinity;
  const reset = () => {
    clicks = 0;
    lastClick = -Infinity;
  };
  return {
    get enabled() { return enabled; },
    reset,
    click(time) {
      if (enabled || !Number.isFinite(time)) return false;
      if (time - lastClick > MAX_CLICK_GAP_MS || time < lastClick) reset();
      lastClick = time;
      if (++clicks < REQUIRED_CLICKS) return false;
      enabled = true;
      reset();
      try {
        write(STORAGE_KEY, '1');
      } catch (_) {
        // Keep the activated state until this page closes.
      }
      return true;
    },
  };
}
