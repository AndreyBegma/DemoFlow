import { Button } from '@andrewbehma/glass-ui/button';
import { Card } from '@andrewbehma/glass-ui/card';

const SECTIONS = Array.from({ length: 30 }, (_, i) => i + 1);
const LOG_LINES = Array.from({ length: 60 }, (_, i) => i + 1);

export function Long() {
  return (
    <div className="grid grid-cols-[1fr_16rem] gap-6">
      <section>
        <h1 className="text-2xl font-semibold">Long page</h1>
        {SECTIONS.map((n) => (
          <article key={n} className="mt-8">
            <h2 className="text-xl font-semibold">Section {n}</h2>
            <p className="mt-2 text-sm opacity-70">
              Section {n} holds fixed text so the page height never changes
              between runs. Scroll down to reach the end of the page.
            </p>
          </article>
        ))}
        <Button
          className="mt-8"
          onClick={() => window.scrollTo({ top: 0, behavior: 'instant' })}
        >
          Back to top
        </Button>
      </section>
      <aside className="sticky top-4 self-start">
        <Card>
          <section
            data-testid="log-panel"
            // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region must be keyboard reachable
            tabIndex={0}
            aria-label="Log"
            className="h-64 overflow-y-auto text-xs"
          >
            {LOG_LINES.map((n) => (
              <p key={n}>Log line {n}</p>
            ))}
          </section>
        </Card>
      </aside>
    </div>
  );
}
