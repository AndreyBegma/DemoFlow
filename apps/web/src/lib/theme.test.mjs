import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applyTheme,
  readStoredTheme,
  resolveTheme,
  storeTheme,
  THEME_BOOTSTRAP_SCRIPT,
  THEME_STORAGE_KEY,
} from './theme.ts';

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
    values,
  };
}
const blocked = () => {
  throw new Error('SecurityError: storage is blocked');
};

test('system follows the preference; dark and light ignore it', () => {
  assert.equal(resolveTheme('system', true), 'light');
  assert.equal(resolveTheme('system', false), 'dark');
  assert.equal(resolveTheme('dark', true), 'dark');
  assert.equal(resolveTheme('light', false), 'light');
});

test('a stored mode is read back; anything else is system', () => {
  assert.equal(
    readStoredTheme(() => memoryStorage({ 'df-theme': 'light' })),
    'light',
  );
  assert.equal(
    readStoredTheme(() => memoryStorage({ 'df-theme': 'dark' })),
    'dark',
  );
  assert.equal(
    readStoredTheme(() => memoryStorage({ 'df-theme': 'neon' })),
    'system',
  );
  assert.equal(
    readStoredTheme(() => memoryStorage()),
    'system',
  );
});

test('system clears the key; dark and light store it', () => {
  const storage = memoryStorage();
  storeTheme('light', () => storage);
  assert.equal(storage.values.get(THEME_STORAGE_KEY), 'light');
  storeTheme('system', () => storage);
  assert.equal(storage.values.has(THEME_STORAGE_KEY), false);
});

test('blocked storage reads as system and never throws on write', () => {
  assert.equal(readStoredTheme(blocked), 'system');
  assert.doesNotThrow(() => storeTheme('dark', blocked));
});

test('applyTheme sets the mode and the resolved theme', () => {
  const attributes = {};
  applyTheme({ setAttribute: (k, v) => (attributes[k] = v) }, 'system', true);
  assert.deepEqual(attributes, {
    'data-theme-mode': 'system',
    'data-theme': 'light',
  });
});

/** Runs the inline script against a fake document and returns its root. */
function boot({ storage, prefersLight }) {
  const attributes = {};
  const listeners = [];
  const query = {
    matches: prefersLight,
    addEventListener: (_type, listener) => listeners.push(listener),
  };
  const root = {
    setAttribute: (k, v) => (attributes[k] = v),
    getAttribute: (k) => attributes[k] ?? null,
  };
  const window = { matchMedia: () => query };
  // A browser that blocks storage throws on any use of `localStorage`.
  const localStorage =
    storage === 'blocked' ? new Proxy({}, { get: blocked }) : storage;
  new Function('document', 'window', 'localStorage', THEME_BOOTSTRAP_SCRIPT)(
    { documentElement: root },
    window,
    localStorage,
  );
  return {
    attributes,
    flip(matches) {
      query.matches = matches;
      for (const listener of listeners) listener();
    },
  };
}

test('the bootstrap script applies a stored theme', () => {
  const { attributes } = boot({
    storage: memoryStorage({ 'df-theme': 'light' }),
    prefersLight: false,
  });
  assert.equal(attributes['data-theme'], 'light');
  assert.equal(attributes['data-theme-mode'], 'light');
});

test('the bootstrap script follows the system live while in system mode', () => {
  const page = boot({ storage: memoryStorage(), prefersLight: true });
  assert.equal(page.attributes['data-theme'], 'light');
  page.flip(false);
  assert.equal(page.attributes['data-theme'], 'dark');
});

test('a fixed mode ignores a system change', () => {
  const page = boot({
    storage: memoryStorage({ 'df-theme': 'dark' }),
    prefersLight: false,
  });
  page.flip(true);
  assert.equal(page.attributes['data-theme'], 'dark');
});

test('blocked storage still renders, following the system', () => {
  const page = boot({ storage: 'blocked', prefersLight: true });
  assert.equal(page.attributes['data-theme-mode'], 'system');
  assert.equal(page.attributes['data-theme'], 'light');
});
