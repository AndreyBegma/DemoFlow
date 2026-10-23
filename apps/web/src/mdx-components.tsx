import type { MDXComponents } from 'mdx/types';
import Link from 'next/link';
import type { ComponentPropsWithoutRef, ReactNode } from 'react';

/** The anchor id of a heading: its text, lower-cased, words joined by `-`. */
export function headingId(children: ReactNode): string | undefined {
  if (typeof children !== 'string') return undefined;
  return children
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

// Content surfaces stay plain and readable (vision §9): tokens only, no glass.
const components: MDXComponents = {
  h1: (props) => (
    <h1 className="text-3xl font-semibold text-balance" {...props} />
  ),
  h2: ({ children, ...props }) => (
    <h2
      id={headingId(children)}
      className="mt-10 scroll-mt-24 border-t border-line pt-6 text-2xl font-semibold"
      {...props}
    >
      {children}
    </h2>
  ),
  h3: ({ children, ...props }) => (
    <h3
      id={headingId(children)}
      className="mt-6 scroll-mt-24 text-lg font-semibold"
      {...props}
    >
      {children}
    </h3>
  ),
  p: (props) => <p className="mt-4 leading-7 text-ink-2" {...props} />,
  ul: (props) => (
    <ul className="mt-4 list-disc space-y-2 pl-6 text-ink-2" {...props} />
  ),
  ol: (props) => (
    <ol className="mt-4 list-decimal space-y-2 pl-6 text-ink-2" {...props} />
  ),
  li: (props) => <li className="leading-7" {...props} />,
  strong: (props) => <strong className="font-semibold text-ink" {...props} />,
  a: ({ href = '', ...props }: ComponentPropsWithoutRef<'a'>) =>
    href.startsWith('/') ? (
      <Link href={href} className="text-accent underline" {...props} />
    ) : (
      <a
        href={href}
        className="text-accent underline"
        rel="noopener noreferrer"
        {...props}
      />
    ),
  code: (props) => (
    <code
      className="rounded-sm border border-line bg-raised px-1.5 py-0.5 font-mono text-[0.9em] text-ink"
      {...props}
    />
  ),
  pre: (props) => (
    <pre
      className="mt-4 overflow-x-auto rounded-surface border border-line bg-raised p-4 font-mono text-sm leading-6 text-ink [&>code]:border-0 [&>code]:bg-transparent [&>code]:p-0 [&>code]:text-[1em]"
      {...props}
    />
  ),
  blockquote: (props) => (
    <blockquote
      className="mt-6 rounded-surface border border-line-strong border-l-4 bg-raised px-4 py-1 text-ink"
      {...props}
    />
  ),
  table: (props) => (
    <div className="mt-4 overflow-x-auto">
      <table
        className="w-full border-collapse text-left text-sm text-ink-2"
        {...props}
      />
    </div>
  ),
  th: (props) => (
    <th
      className="border-b border-line-strong px-3 py-2 font-semibold text-ink"
      {...props}
    />
  ),
  td: (props) => (
    <td className="border-b border-line px-3 py-2 align-top" {...props} />
  ),
};

export function useMDXComponents(): MDXComponents {
  return components;
}
