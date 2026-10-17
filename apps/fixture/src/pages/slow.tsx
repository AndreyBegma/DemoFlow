import { Button } from '@andrewbehma/glass-ui/button';
import { Spinner } from '@andrewbehma/glass-ui/spinner';
import { useEffect, useState } from 'react';

const REPORT_DELAY_MS = 1500;

type State = 'idle' | 'loading' | 'ready';

export function Slow() {
  const [state, setState] = useState<State>('idle');

  useEffect(() => {
    if (state !== 'loading') return;
    const timer = setTimeout(() => setState('ready'), REPORT_DELAY_MS);
    return () => clearTimeout(timer);
  }, [state]);

  return (
    <section>
      <h1 className="text-2xl font-semibold">Slow report</h1>
      <div className="mt-4 flex items-center gap-3">
        <Button
          onClick={() => setState('loading')}
          disabled={state === 'loading'}
        >
          Load report
        </Button>
        {state === 'loading' && <Spinner label="Loading report" />}
        {state === 'ready' && <p>Report ready</p>}
      </div>
    </section>
  );
}
