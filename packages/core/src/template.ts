/**
 * `{{…}}` placeholders in the strings of a step (spec 165): `{{<as>.<field>}}`
 * for a field of the current item, `{{index}}` for its 1-based position.
 * Spaces inside the braces are allowed; `\{{` is a literal `{{`.
 */
export type Placeholder =
  | { kind: 'index' }
  | { kind: 'field'; name: string; field: string };

/** Literal text and placeholders, in order. */
export type Template = readonly (string | Placeholder)[];

export type TemplateParse =
  | { ok: true; template: Template }
  | { ok: false; message: string };

const TOKEN = /\\\{\{|\{\{([^{}]*)\}\}|\{\{/g;
const FIELD = /^([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)$/;

export function parseTemplate(text: string): TemplateParse {
  const template: (string | Placeholder)[] = [];
  let literal = '';
  let last = 0;
  for (const match of text.matchAll(TOKEN)) {
    literal += text.slice(last, match.index);
    last = match.index + match[0].length;
    if (match[0] === '\\{{') {
      literal += '{{';
      continue;
    }
    const inner = match[1];
    if (inner === undefined) {
      return {
        ok: false,
        message: 'expected }} to close {{ (write \\{{ for a literal {{)',
      };
    }
    const body = inner.trim();
    const field = FIELD.exec(body);
    let placeholder: Placeholder;
    if (body === 'index') {
      placeholder = { kind: 'index' };
    } else if (field !== null) {
      placeholder = { kind: 'field', name: field[1], field: field[2] };
    } else {
      return {
        ok: false,
        message: `expected {{<name>.<field>}} or {{index}}, found ${match[0]}`,
      };
    }
    if (literal !== '') template.push(literal);
    literal = '';
    template.push(placeholder);
  }
  literal += text.slice(last);
  if (literal !== '') template.push(literal);
  return { ok: true, template };
}

export function placeholders(template: Template): Placeholder[] {
  return template.filter((part) => typeof part !== 'string');
}

export type DataValue = string | number | boolean;

/** The item one iteration of a `repeat` substitutes. */
export interface TemplateScope {
  name: string;
  item: Readonly<Record<string, DataValue>>;
  /** 1-based. */
  index: number;
}

/**
 * The template's text in `scope`: numbers and booleans as their string form.
 * Without a scope only literal text is allowed, unescaped.
 */
export function renderTemplate(
  template: Template,
  scope?: TemplateScope,
): string {
  return template
    .map((part) => {
      if (typeof part === 'string') return part;
      if (scope === undefined)
        throw new Error('a placeholder outside a repeat');
      if (part.kind === 'index') return String(scope.index);
      const value =
        part.name === scope.name ? scope.item[part.field] : undefined;
      if (value === undefined) {
        throw new Error(`no value for {{${part.name}.${part.field}}}`);
      }
      return String(value);
    })
    .join('');
}
