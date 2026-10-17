import { Card } from '@andrewbehma/glass-ui/card';
import { Tooltip } from '@andrewbehma/glass-ui/tooltip';

export function Hover() {
  return (
    <section>
      <h1 className="text-2xl font-semibold">Hover</h1>
      <div className="mt-4 w-64">
        <Tooltip content="Details">
          <div data-testid="hover-card">
            <Card>Hover over this card</Card>
          </div>
        </Tooltip>
      </div>
    </section>
  );
}
