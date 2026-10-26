'use client';

import {
  MenuContent,
  MenuLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRoot,
  MenuTrigger,
} from '@andrewbehma/glass-ui/menu';
import { Monitor, Moon, Sun } from 'lucide-react';
import { t } from '@/i18n';
import { THEME_MODES, type ThemeMode } from '@/lib/theme';
import { useThemeMode } from '@/lib/use-theme-mode';

const ICONS: Record<ThemeMode, typeof Sun> = {
  system: Monitor,
  dark: Moon,
  light: Sun,
};

/**
 * The theme control of the site header (spec #376, Decision 1): the same
 * modes and storage as the app's account menu, so a choice made on the
 * landing page carries into `/app`. A radio menu for the same reason the
 * account menu uses one: it is reachable by Tab and the arrow keys.
 */
export function ThemeToggle() {
  const [mode, chooseTheme] = useThemeMode();
  const Icon = ICONS[mode];
  return (
    <MenuRoot>
      <MenuTrigger
        aria-label={t('site.theme.label')}
        className="inline-flex size-9 shrink-0 items-center justify-center rounded-control text-ink-2 hover:bg-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        <Icon aria-hidden="true" className="size-4" />
      </MenuTrigger>
      <MenuContent align="end">
        <MenuLabel>{t('app.shell.account.theme')}</MenuLabel>
        <MenuRadioGroup value={mode} onValueChange={chooseTheme}>
          {THEME_MODES.map((value) => (
            <MenuRadioItem
              key={value}
              value={value}
              // Keep the menu open so the change can be seen and undone.
              onSelect={(event) => event.preventDefault()}
            >
              {t(`app.shell.theme.${value}`)}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuContent>
    </MenuRoot>
  );
}
