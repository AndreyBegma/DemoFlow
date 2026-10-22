import type { z } from 'zod';

/** An error or warning, addressed by its path in the input: `steps[3].target`. */
export interface Issue {
  path: string;
  code: string;
  message: string;
}

export function formatPath(path: readonly PropertyKey[]): string {
  let out = '';
  for (const segment of path) {
    if (typeof segment === 'number') {
      out += `[${segment}]`;
    } else {
      const key = String(segment);
      if (/^[A-Za-z_$][\w$]*$/.test(key)) {
        out += out === '' ? key : `.${key}`;
      } else {
        out += `[${JSON.stringify(key)}]`;
      }
    }
  }
  return out;
}

export function toIssues(
  issues: readonly z.core.$ZodIssue[],
  prefix: readonly PropertyKey[] = [],
): Issue[] {
  return issues.flatMap((issue): Issue[] => {
    const path = [...prefix, ...issue.path];
    if (issue.code === 'unrecognized_keys') {
      return issue.keys.map((key) => ({
        path: formatPath([...path, key]),
        code: issue.code,
        message: 'unknown field',
      }));
    }
    if (issue.code === 'invalid_union') {
      // When exactly one branch fails only below the root, the input meant
      // that branch: report its errors, not the whole union.
      const candidates = issue.errors.filter((branch) =>
        branch.every((inner) => inner.path.length > 0),
      );
      if (candidates.length === 1) return toIssues(candidates[0], path);
    }
    return [
      { path: formatPath(path), code: issue.code, message: issue.message },
    ];
  });
}
