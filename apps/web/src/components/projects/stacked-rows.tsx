import type { ReactNode } from 'react';

/**
 * Classes that turn a Glass UI table into stacked rows below the `md`
 * breakpoint (spec #374, Decision 3): the header hides, every row becomes a
 * block and every cell a labelled line, so a narrow screen never scrolls
 * sideways. One DOM for both layouts, so a locator finds each cell once.
 */
export const stacked = {
  table: 'block md:table',
  head: 'hidden md:table-header-group',
  body: 'block md:table-row-group',
  row: 'flex flex-wrap items-start gap-x-3 gap-y-1.5 px-1 py-3 md:table-row md:p-0',
  /** A labelled line on its own; a normal cell from `md` up. */
  cell: 'flex w-full min-w-0 items-baseline gap-3 p-0 md:table-cell md:w-auto md:px-3 md:py-2.5',
  /** The row's title on a narrow screen: it takes what the line has left. */
  lead: 'block min-w-0 flex-1 p-0 md:table-cell md:px-3 md:py-2.5',
  /** A control that sits before the title on a narrow screen. */
  control: 'block shrink-0 p-0 md:table-cell md:w-10 md:px-3 md:py-2.5',
} as const;

/** The column name before a cell's value, shown only while rows are stacked. */
export function CellLabel({ children }: { children: ReactNode }) {
  return (
    <span className="w-24 shrink-0 text-xs text-ink-2 md:hidden">
      {children}
    </span>
  );
}
