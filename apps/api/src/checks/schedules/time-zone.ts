import { ValidateBy, type ValidationOptions } from 'class-validator';

/** Whether `zone` is an IANA time zone this runtime knows. */
export function isTimeZone(zone: string): boolean {
  if (zone.length === 0 || zone.length > 64) {
    return false;
  }
  if (Intl.supportedValuesOf('timeZone').includes(zone)) {
    return true;
  }
  // `supportedValuesOf` lists canonical names only: `UTC`, `Europe/Kyiv`
  // and other aliases are missing from it on some runtimes.
  if (!/^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/.test(zone)) {
    return false;
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** An IANA time zone name (spec #362, Decision 3). */
export function IsTimeZone(options?: ValidationOptions): PropertyDecorator {
  return ValidateBy(
    {
      name: 'isTimeZone',
      validator: {
        validate: (value) => typeof value === 'string' && isTimeZone(value),
        defaultMessage: () => '$property is not a time zone',
      },
    },
    options,
  );
}
