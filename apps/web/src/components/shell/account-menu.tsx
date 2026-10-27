'use client';

import { Avatar } from '@andrewbehma/glass-ui/avatar';
import {
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRoot,
  MenuSeparator,
  MenuTrigger,
} from '@andrewbehma/glass-ui/menu';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { t } from '@/i18n';
import { signOut } from '@/lib/api';
import { THEME_MODES } from '@/lib/theme';
import { useThemeMode } from '@/lib/use-theme-mode';

/**
 * The account menu in the top bar (spec #373, Decision 6): who is signed in,
 * account settings, the theme and sign out. The theme is a radio group rather
 * than a segmented control: glass-ui documents that a segmented control inside
 * a menu is unreachable by Tab and the arrow keys.
 */
export function AccountMenu({ email }: { email: string }) {
  const router = useRouter();
  const [mode, chooseTheme] = useThemeMode();
  const [signingOut, setSigningOut] = useState(false);

  async function leave() {
    setSigningOut(true);
    await signOut();
    router.replace('/sign-in');
    router.refresh();
  }

  return (
    <MenuRoot>
      <MenuTrigger
        aria-label={t('app.shell.account.label')}
        className="rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        <Avatar size="sm" name={email} />
      </MenuTrigger>
      <MenuContent align="end">
        <MenuLabel className="normal-case tracking-normal">
          <span className="block truncate text-sm text-ink-2">{email}</span>
        </MenuLabel>
        <MenuSeparator />
        <MenuItem onSelect={() => router.push('/app/settings')}>
          {t('app.shell.account.settings')}
        </MenuItem>
        <MenuSeparator />
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
        <MenuSeparator />
        <MenuItem
          tone="danger"
          disabled={signingOut}
          onSelect={(event) => {
            event.preventDefault();
            void leave();
          }}
        >
          {signingOut ? t('app.shell.signingOut') : t('app.shell.signOut')}
        </MenuItem>
      </MenuContent>
    </MenuRoot>
  );
}
