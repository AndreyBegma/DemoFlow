'use client';

import { useEffect, useState } from 'react';
import {
  applyTheme,
  isThemeMode,
  LIGHT_QUERY,
  storeTheme,
  THEME_MODE_ATTRIBUTE,
  type ThemeMode,
} from './theme';

/**
 * The theme mode and a setter that stores and applies it. Every theme control
 * — the account menu in the app, the toggle in the site header — uses this, so
 * a choice made on one page is the one every other page reads.
 */
export function useThemeMode(): [ThemeMode, (value: string) => void] {
  const [mode, setMode] = useState<ThemeMode>('system');

  // The bootstrap script has already set the mode on <html>; read it back.
  useEffect(() => {
    const current = document.documentElement.getAttribute(THEME_MODE_ATTRIBUTE);
    if (isThemeMode(current)) setMode(current);
  }, []);

  function chooseTheme(value: string) {
    if (!isThemeMode(value)) return;
    setMode(value);
    storeTheme(value, () => window.localStorage);
    applyTheme(
      document.documentElement,
      value,
      window.matchMedia(LIGHT_QUERY).matches,
    );
  }

  return [mode, chooseTheme];
}
