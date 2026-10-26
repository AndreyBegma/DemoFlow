export const THEME_STORAGE_KEY = 'df-theme';

export const THEME_MODES = ['system', 'dark', 'light'] as const;
export type ThemeMode = (typeof THEME_MODES)[number];
export type Theme = 'dark' | 'light';

/** The chosen mode lives on `<html>` too, so every script reads one value. */
export const THEME_MODE_ATTRIBUTE = 'data-theme-mode';

export const LIGHT_QUERY = '(prefers-color-scheme: light)';

export function isThemeMode(value: unknown): value is ThemeMode {
  return THEME_MODES.some((mode) => mode === value);
}

/** The concrete theme a mode resolves to, given the system preference. */
export function resolveTheme(mode: ThemeMode, prefersLight: boolean): Theme {
  if (mode !== 'system') return mode;
  return prefersLight ? 'light' : 'dark';
}

/**
 * The stored mode, or `system`. `storage` is a getter because reading
 * `window.localStorage` itself throws when the browser blocks storage.
 */
export function readStoredTheme(storage: () => Storage): ThemeMode {
  try {
    const stored = storage().getItem(THEME_STORAGE_KEY);
    return isThemeMode(stored) ? stored : 'system';
  } catch {
    return 'system';
  }
}

/** Remembers `mode`; with storage blocked the choice lasts until reload. */
export function storeTheme(mode: ThemeMode, storage: () => Storage): void {
  try {
    if (mode === 'system') storage().removeItem(THEME_STORAGE_KEY);
    else storage().setItem(THEME_STORAGE_KEY, mode);
  } catch {
    // Storage blocked: the attribute on <html> still holds it for this page.
  }
}

/** Sets the mode and the theme it resolves to on the root element. */
export function applyTheme(
  root: Pick<Element, 'setAttribute'>,
  mode: ThemeMode,
  prefersLight: boolean,
): void {
  root.setAttribute(THEME_MODE_ATTRIBUTE, mode);
  root.setAttribute('data-theme', resolveTheme(mode, prefersLight));
}

/**
 * Runs inline in `<head>` before first paint, so a page never flashes the
 * other theme (spec #373, Decision 6). It reads the stored mode, sets
 * `data-theme-mode` and `data-theme`, and while the mode is `system` follows
 * the OS live — on every page, inside the app shell or not. A string, not a
 * module: it must not depend on anything.
 */
export const THEME_BOOTSTRAP_SCRIPT = `(function(){var d=document.documentElement,m=null;try{m=localStorage.getItem('${THEME_STORAGE_KEY}')}catch(e){}if(m!=='dark'&&m!=='light')m='system';d.setAttribute('${THEME_MODE_ATTRIBUTE}',m);var q=window.matchMedia?window.matchMedia('${LIGHT_QUERY}'):null;function a(){var c=d.getAttribute('${THEME_MODE_ATTRIBUTE}');d.setAttribute('data-theme',c==='dark'||c==='light'?c:q&&q.matches?'light':'dark')}a();if(q&&q.addEventListener)q.addEventListener('change',a)})()`;
