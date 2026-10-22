'use client';

import { Banner } from '@andrewbehma/glass-ui/banner';
import { Button } from '@andrewbehma/glass-ui/button';
import { Card } from '@andrewbehma/glass-ui/card';
import { DialogContent, DialogRoot } from '@andrewbehma/glass-ui/dialog';
import { Field, Input } from '@andrewbehma/glass-ui/field';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { t } from '@/i18n';
import { deleteAccount } from '@/lib/api';

type DeleteError =
  | 'accountDeletion.mismatch'
  | 'accountDeletion.failed'
  | 'auth.errors.rateLimited';

/** As the API compares them: trimmed, in any case (spec #177, Decision 1). */
function emailMatches(typed: string, email: string): boolean {
  return typed.trim().toLowerCase() === email.trim().toLowerCase();
}

/**
 * The danger zone of settings. Not `ConfirmDialog`: its verb cannot stay
 * disabled until the typed email matches.
 */
export function DeleteAccount({ email }: { email: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<DeleteError | undefined>();
  const matches = emailMatches(typed, email);
  const inputId = 'delete-account-email';

  function onOpenChange(next: boolean) {
    // A request in flight is not hidden by closing over it.
    if (busy) return;
    setOpen(next);
    if (!next) {
      setTyped('');
      setError(undefined);
    }
  }

  async function submit() {
    if (!matches || busy) return;
    setBusy(true);
    setError(undefined);
    const result = await deleteAccount(typed);
    if (!result.ok) {
      setError(
        result.status === 400
          ? 'accountDeletion.mismatch'
          : result.error === 'rate_limited'
            ? 'auth.errors.rateLimited'
            : 'accountDeletion.failed',
      );
      setBusy(false);
      return;
    }
    router.replace('/?deleted=1');
    router.refresh();
  }

  return (
    <Card pad="lg">
      <h2 className="text-lg font-semibold">{t('accountDeletion.title')}</h2>
      <p className="mt-2 text-sm text-ink-2">{t('accountDeletion.body')}</p>
      <div className="mt-4">
        <Button type="button" variant="danger" onClick={() => setOpen(true)}>
          {t('accountDeletion.open')}
        </Button>
      </div>
      <DialogRoot open={open} onOpenChange={onOpenChange}>
        <DialogContent
          title={t('accountDeletion.dialogTitle')}
          description={t('accountDeletion.consequence')}
          footer={
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="glass"
                disabled={busy}
                onClick={() => onOpenChange(false)}
              >
                {t('accountDeletion.cancel')}
              </Button>
              <Button
                type="submit"
                form="delete-account-form"
                variant="danger"
                disabled={!matches || busy}
              >
                {busy
                  ? t('accountDeletion.deleting')
                  : t('accountDeletion.confirm')}
              </Button>
            </div>
          }
        >
          <form
            id="delete-account-form"
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            {error ? <Banner tone="danger">{t(error)}</Banner> : null}
            <Field
              label={t('accountDeletion.emailLabel', { email })}
              htmlFor={inputId}
            >
              <Input
                id={inputId}
                type="email"
                autoComplete="off"
                spellCheck={false}
                value={typed}
                disabled={busy}
                onChange={(event) => setTyped(event.target.value)}
              />
            </Field>
          </form>
        </DialogContent>
      </DialogRoot>
    </Card>
  );
}
