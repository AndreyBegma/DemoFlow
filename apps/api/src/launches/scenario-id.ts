import { ValidateBy, type ValidationOptions } from 'class-validator';

export const SCENARIO_ID_MAX = 255;
const PREFIX = 'demoflow/';
const SUFFIX = '.demo.json';
/** `\`, `:`, and the control characters U+0000–U+001F and U+007F. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: the rule names them.
const FORBIDDEN = /[\\:\u0000-\u001f\u007f]/;

/**
 * A scenario's path relative to the project root (spec #247, Protocol): the
 * API checks it on input, the daemon again on receipt. It never reaches the
 * file system here; the rule keeps it from naming anything outside
 * `demoflow/` on the machine.
 */
export function isScenarioId(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > SCENARIO_ID_MAX ||
    !value.startsWith(PREFIX) ||
    !value.endsWith(SUFFIX) ||
    FORBIDDEN.test(value)
  ) {
    return false;
  }
  return value
    .split('/')
    .every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

export function IsScenarioId(options?: ValidationOptions): PropertyDecorator {
  return ValidateBy(
    {
      name: 'isScenarioId',
      validator: {
        validate: (value) => isScenarioId(value),
        defaultMessage: () => '$property is not a scenario id',
      },
    },
    options,
  );
}
