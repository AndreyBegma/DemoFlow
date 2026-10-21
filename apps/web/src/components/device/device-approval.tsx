'use client';

import { Banner } from '@andrewbehma/glass-ui/banner';
import { Button, buttonClassName } from '@andrewbehma/glass-ui/button';
import { Field, Input } from '@andrewbehma/glass-ui/field';
import Link from 'next/link';
import { useId, useState } from 'react';
import { t } from '@/i18n';
import {
  type ApiError,
  approveDevice,
  type DeviceRequest,
  denyDevice,
} from '@/lib/api';
import { formatDate } from '@/lib/format-date';
import type { ErrorKey } from '@/lib/validation';
import { apiErrorKey } from '../auth/form-parts';

const NAME_MAX = 64;

type Outcome = 'approved' | 'denied';
type Failure =
  | 'device.errors.name'
  | 'device.errors.limit'
  | 'device.errors.notFound'
  | 'device.errors.notVerified'
  | ErrorKey;

function failureFor(error: ApiError, status: number | undefined): Failure {
  if (status === 409) return 'device.errors.limit';
  if (status === 404) return 'device.errors.notFound';
  if (status === 403) return 'device.errors.notVerified';
  return apiErrorKey(error);
}

/**
 * The approval card (spec #135, Decision 6): what is asking to pair, a
 * prefilled editable name, Approve and Deny.
 */
export function DeviceApproval({
  request,
  canApprove,
}: {
  request: DeviceRequest;
  /** False for an unverified email: the details show, the actions do not. */
  canApprove: boolean;
}) {
  const nameId = useId();
  const [name, setName] = useState(request.hostname.trim().slice(0, NAME_MAX));
  const [nameInvalid, setNameInvalid] = useState(false);
  const [pending, setPending] = useState<'approve' | 'deny' | null>(null);
  const [failure, setFailure] = useState<Failure | undefined>();
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  if (outcome) {
    return (
      <div className="flex flex-col gap-4">
        <Banner tone={outcome === 'approved' ? 'ok' : 'info'}>
          <p className="font-medium">
            {outcome === 'approved'
              ? t('device.done.approvedTitle')
              : t('device.done.deniedTitle')}
          </p>
          <p>
            {outcome === 'approved'
              ? t('device.done.approvedBody')
              : t('device.done.deniedBody')}
          </p>
        </Banner>
        <div>
          <Link
            href="/app/machines"
            className={buttonClassName({ variant: 'glass' })}
          >
            {t('device.done.machines')}
          </Link>
        </div>
      </div>
    );
  }

  async function approve() {
    const trimmed = name.trim();
    if (trimmed.length < 1 || [...trimmed].length > NAME_MAX) {
      setNameInvalid(true);
      return;
    }
    setNameInvalid(false);
    setFailure(undefined);
    setPending('approve');
    const result = await approveDevice(request.userCode, trimmed);
    if (!result.ok) {
      setFailure(failureFor(result.error, result.status));
      setPending(null);
      return;
    }
    setOutcome('approved');
  }

  async function deny() {
    setFailure(undefined);
    setPending('deny');
    const result = await denyDevice(request.userCode);
    if (!result.ok) {
      setFailure(failureFor(result.error, result.status));
      setPending(null);
      return;
    }
    setOutcome('denied');
  }

  return (
    <div className="flex flex-col gap-4">
      {failure ? <Banner tone="danger">{t(failure)}</Banner> : null}
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
        <dt className="text-ink-2">{t('device.approve.code')}</dt>
        <dd className="font-mono text-lg font-semibold tracking-widest">
          {request.userCode}
        </dd>
        <dt className="text-ink-2">{t('device.approve.hostname')}</dt>
        <dd className="min-w-0 break-words">{request.hostname}</dd>
        <dt className="text-ink-2">{t('device.approve.os')}</dt>
        <dd className="min-w-0 break-words">{request.os}</dd>
        <dt className="text-ink-2">{t('device.approve.cliVersion')}</dt>
        <dd className="min-w-0 break-words">{request.cliVersion}</dd>
        <dt className="text-ink-2">{t('device.approve.requested')}</dt>
        <dd>{formatDate(request.createdAt)}</dd>
      </dl>
      {canApprove ? (
        <>
          <Banner tone="warn">{t('device.approve.warning')}</Banner>
          <Field
            label={t('device.approve.nameLabel')}
            htmlFor={nameId}
            hint={t('device.approve.nameHint')}
            error={nameInvalid ? t('device.errors.name') : undefined}
          >
            <Input
              id={nameId}
              value={name}
              onChange={(event) => setName(event.target.value)}
              autoComplete="off"
              aria-invalid={nameInvalid ? true : undefined}
              required
            />
          </Field>
          <div className="flex gap-3">
            <Button type="button" disabled={pending !== null} onClick={approve}>
              {pending === 'approve'
                ? t('device.approve.submitting')
                : t('device.approve.submit')}
            </Button>
            <Button
              type="button"
              variant="danger"
              disabled={pending !== null}
              onClick={deny}
            >
              {pending === 'deny'
                ? t('device.approve.denying')
                : t('device.approve.deny')}
            </Button>
          </div>
        </>
      ) : null}
    </div>
  );
}
