import test from 'node:test';
import assert from 'node:assert/strict';
import { createThemeController, resolveTheme, THEME_STORAGE_KEY } from '../src/theme.js';

function setup(storage, prefersDark = true) {
  const root = { dataset: {} };
  const callbacks = {};
  const button = { dataset: {}, attributes: {},
    setAttribute(name, value) { this.attributes[name] = value; },
    addEventListener: (_, callback) => { callbacks.click = callback; } };
  const colorScheme = { matches: prefersDark, addEventListener: (_, callback) => { callbacks.system = callback; } };
  createThemeController({ root, button, colorScheme, storage });
  return { root, button,
    click() { callbacks.click(); },
    device(dark) { colorScheme.matches = dark; callbacks.system(); } };
}

test('icon button cycles system → dark → light → system, persists and follows device only in system mode', () => {
  const values = new Map();
  const storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) };
  const theme = setup(storage);
  assert.equal(theme.button.dataset.mode, 'system'); assert.equal(theme.root.dataset.theme, 'dark');
  theme.device(false); assert.equal(theme.root.dataset.theme, 'light');
  theme.click(); assert.equal(theme.button.dataset.mode, 'dark'); assert.equal(theme.root.dataset.theme, 'dark');
  assert.ok(theme.button.attributes['aria-label'].includes('クリックでライトに切り替え'));
  theme.device(false); assert.equal(theme.root.dataset.theme, 'dark');
  assert.equal(values.get(THEME_STORAGE_KEY), 'dark');
  assert.equal(setup(storage, false).root.dataset.theme, 'dark');
  const restored = setup(storage, false);
  assert.equal(restored.button.dataset.mode, 'dark');
  theme.click(); assert.equal(theme.button.dataset.mode, 'light'); theme.device(true); assert.equal(theme.root.dataset.theme, 'light');
  theme.click(); assert.equal(theme.button.dataset.mode, 'system'); assert.equal(theme.root.dataset.theme, 'dark');
  theme.device(false); assert.equal(theme.root.dataset.theme, 'light');
});

test('invalid preferences and unavailable storage fall back safely while switching still works', () => {
  const theme = setup({ getItem() { throw new Error('Blocked'); }, setItem() { throw new Error('Blocked'); } });
  assert.equal(theme.button.dataset.mode, 'system');
  assert.doesNotThrow(() => { theme.click(); theme.click(); }); assert.equal(theme.root.dataset.theme, 'light');
  assert.equal(setup({ getItem: () => 'invalid' }, false).root.dataset.theme, 'light');
  assert.equal(resolveTheme('invalid', true), 'dark');
  assert.equal(resolveTheme('invalid', false), 'light');
});
