'use client';

import { Banner } from '@andrewbehma/glass-ui/banner';
import { Button, buttonClassName } from '@andrewbehma/glass-ui/button';
import { Field, Input } from '@andrewbehma/glass-ui/field';
import { KeyValueList } from '@andrewbehma/glass-ui/key-value-list';
import { CircleCheck, CircleX } from 'lucide-react';
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

  // The answer replaces the question (spec #375, Decision 3): nothing is left
  // to approve, so no form comes back.
  if (outcome) {
    const approved = outcome === 'approved';
    const Icon = approved ? CircleCheck : CircleX;
    return (
      <div
        role="status"
        className="flex flex-col items-center gap-3 py-4 text-center"
      >
        <Icon
          size={40}
          aria-hidden="true"
          className={approved ? 'text-ok' : 'text-ink-3'}
        />
        <h2 className="text-xl font-semibold">
          {approved
            ? t('device.done.approvedTitle')
            : t('device.done.deniedTitle')}
        </h2>
        <p className="text-ink-2">
          {approved ? t('device.done.closeTab') : t('device.done.deniedBody')}
        </p>
        <Link
          href="/app/machines"
          className={`mt-2 ${buttonClassName({ variant: 'glass' })}`}
        >
          {t('device.done.machines')}
        </Link>
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
    <div className="flex flex-col gap-5">
      {failure ? <Banner tone="danger">{t(failure)}</Banner> : null}
      <dl className="flex flex-col items-center gap-1 text-center">
        <dt className="text-sm text-ink-2">{t('device.approve.code')}</dt>
        <dd className="break-all font-mono text-3xl font-semibold tracking-widest tablet:text-4xl">
          {request.userCode}
        </dd>
      </dl>
      <KeyValueList
        columns={2}
        items={[
          {
            key: 'hostname',
            label: t('device.approve.hostname'),
            value: request.hostname,
          },
          { key: 'os', label: t('device.approve.os'), value: request.os },
          {
            key: 'cliVersion',
            label: t('device.approve.cliVersion'),
            value: request.cliVersion,
          },
          {
            key: 'requested',
            label: t('device.approve.requested'),
            value: formatDate(request.createdAt),
          },
        ]}
      />
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
          <div className="flex flex-col gap-3 tablet:flex-row">
            <Button
              type="button"
              size="lg"
              disabled={pending !== null}
              onClick={approve}
            >
              {pending === 'approve'
                ? t('device.approve.submitting')
                : t('device.approve.submit')}
            </Button>
            <Button
              type="button"
              size="lg"
              variant="glass"
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
