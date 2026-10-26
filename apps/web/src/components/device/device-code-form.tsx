'use client';

import { Button } from '@andrewbehma/glass-ui/button';
import { Field, Input } from '@andrewbehma/glass-ui/field';
import { useRouter } from 'next/navigation';
import { useId, useState } from 'react';
import { t } from '@/i18n';
import { normalizeUserCode } from '@/lib/user-code';

/** For a terminal with no browser: the person types the code shown there. */
export function DeviceCodeForm() {
  const router = useRouter();
  const id = useId();
  const [invalid, setInvalid] = useState(false);

  return (
    <form
      noValidate
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        const code = normalizeUserCode(
          String(new FormData(event.currentTarget).get('code') ?? ''),
        );
        if (!code) {
          setInvalid(true);
          return;
        }
        router.push(`/app/device?code=${code}`);
      }}
    >
      <Field
        label={t('device.code.label')}
        htmlFor={id}
        error={invalid ? t('device.code.invalid') : undefined}
      >
        <Input
          id={id}
          name="code"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          className="font-mono text-lg tracking-widest"
          placeholder={t('device.code.placeholder')}
          aria-invalid={invalid ? true : undefined}
          required
        />
      </Field>
      <Button type="submit" variant="solid" size="lg">
        {t('device.code.submit')}
      </Button>
    </form>
  );
}
