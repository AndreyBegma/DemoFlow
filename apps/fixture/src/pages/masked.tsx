import { Button } from '@andrewbehma/glass-ui/button';
import { useEffect, useState } from 'react';

/** The balance arrives this long after it is asked for: in the middle of a step. */
const BALANCE_DELAY_MS = 300;

/** Dark text on white: what a blur visibly changes, so a test can tell a masked frame. */
const SECRET =
  'mt-2 inline-block bg-white px-2 font-mono text-2xl font-bold text-black';

type Balance = 'hidden' | 'loading' | 'shown';

/** Secrets the application marks `data-demoflow-mask` (#197): the video blurs them, the scenario says nothing. */
export function Masked() {
  const [balance, setBalance] = useState<Balance>('hidden');

  useEffect(() => {
    if (balance !== 'loading') return;
    const timer = setTimeout(() => setBalance('shown'), BALANCE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [balance]);

  return (
    <section>
      <h1 className="text-2xl font-semibold">Account</h1>
      <p className="mt-4 text-sm">API key</p>
      <p data-demoflow-mask="" data-testid="api-key" className={SECRET}>
        sk-live-4f9a2c71e0d8
      </p>
      <div className="mt-6 flex gap-3">
        <Button onClick={() => setBalance('loading')}>Show balance</Button>
        <Button onClick={() => setBalance('hidden')}>Hide balance</Button>
      </div>
      {balance === 'shown' && (
        <p data-demoflow-mask="" data-testid="balance" className={SECRET}>
          $ 48,213.07 — IBAN DE89 3704 0044 0532 0130 00
        </p>
      )}
    </section>
  );
}
