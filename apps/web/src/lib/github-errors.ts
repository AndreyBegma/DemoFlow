import { t } from '@/i18n';

// The `error` codes the API's GitHub callback redirects with (spec #126). One
// contract: a code added there gets its message here.
const MESSAGES: Record<string, () => string> = {
  github_no_verified_email: () => t('auth.github.errors.noVerifiedEmail'),
  github_link_requires_verified: () =>
    t('auth.github.errors.linkRequiresVerified'),
  github_already_linked_elsewhere: () =>
    t('auth.github.errors.alreadyLinkedElsewhere'),
  github_already_linked: () => t('auth.github.errors.alreadyLinked'),
  github_state_invalid: () => t('auth.github.errors.stateInvalid'),
  github_denied: () => t('auth.github.errors.denied'),
  github_failed: () => t('auth.github.errors.failed'),
};

/**
 * The message for a callback `?error=`, or undefined when there is none. An
 * unknown code still says something went wrong rather than nothing.
 */
export function githubErrorMessage(
  code: string | string[] | undefined,
): string | undefined {
  if (code === undefined) return undefined;
  const value = Array.isArray(code) ? code[0] : code;
  const message = value !== undefined ? MESSAGES[value] : undefined;
  return message ? message() : t('auth.errors.unknown');
}
