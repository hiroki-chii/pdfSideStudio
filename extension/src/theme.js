export const THEME_STORAGE_KEY = 'pdf-side-studio.theme';
const modes = ['dark', 'light', 'system'];
const names = { dark: 'ダーク', light: 'ライト', system: 'デバイスと同じ' };
const normalizeMode = mode => modes.includes(mode) ? mode : 'system';
const nextMode = mode => modes[(modes.indexOf(mode) + 1) % modes.length];

export function resolveTheme(mode, prefersDark) {
  return normalizeMode(mode) === 'system' ? (prefersDark ? 'dark' : 'light') : mode;
}

export function createThemeController({ root, button, colorScheme, storage }) {
  let mode = 'system';
  try { mode = normalizeMode(storage?.getItem(THEME_STORAGE_KEY)); } catch { /* Storage may be unavailable. */ }
  function apply() {
    root.dataset.theme = resolveTheme(mode, colorScheme.matches);
    button.dataset.mode = mode;
    button.setAttribute('aria-label', `表示モード: ${names[mode]}。クリックで${names[nextMode(mode)]}に切り替え`);
    button.title = `表示モード: ${names[mode]}（次: ${names[nextMode(mode)]}）`;
  }
  button.addEventListener('click', () => {
    mode = nextMode(mode);
    apply();
    try { storage?.setItem(THEME_STORAGE_KEY, mode); } catch { /* Keep the choice for this session. */ }
  });
  colorScheme.addEventListener('change', () => { if (mode === 'system') apply(); });
  apply();
}
