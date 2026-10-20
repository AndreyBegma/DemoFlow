import { en } from './en';

export type Locale = 'en';

export const messages = { en } as const;

type Dictionary = (typeof messages)[Locale];

// Dotted paths of the string leaves, at most four levels deep to keep the
// type checker fast.
type Paths<T, Depth extends unknown[] = []> = Depth['length'] extends 4
  ? never
  : {
      [K in keyof T & string]: T[K] extends string
        ? K
        : `${K}.${Paths<T[K], [...Depth, unknown]>}`;
    }[keyof T & string];

export type MessageKey = Paths<Dictionary>;

type MessageAt<T, P extends string> = P extends `${infer Head}.${infer Rest}`
  ? Head extends keyof T
    ? MessageAt<T[Head], Rest>
    : never
  : P extends keyof T
    ? T[P]
    : never;

type Placeholders<S extends string> =
  S extends `${string}{${infer Name}}${infer Rest}`
    ? Name | Placeholders<Rest>
    : never;

export type ParamsArgs<S extends string> = [Placeholders<S>] extends [never]
  ? []
  : [params: Record<Placeholders<S>, string | number>];

/** Fills `{name}` placeholders of a template from `params`. */
export function interpolate<S extends string>(
  template: S,
  ...args: ParamsArgs<S>
): string {
  const params: Record<string, string | number> = args[0] ?? {};
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match,
  );
}

/**
 * The UI string for `key`, with `{name}` placeholders filled from `params`.
 * A pure function, usable in server and client components alike.
 */
export function t<K extends MessageKey>(
  key: K,
  ...args: ParamsArgs<MessageAt<Dictionary, K> & string>
): string {
  const template = key
    .split('.')
    .reduce<unknown>(
      (node, part) => (node as Record<string, unknown>)[part],
      messages.en,
    ) as string;
  return (interpolate as (template: string, ...args: unknown[]) => string)(
    template,
    ...args,
  );
}
