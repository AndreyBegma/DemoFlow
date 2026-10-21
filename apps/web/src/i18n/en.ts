// English UI strings. Nested keys, at most four levels deep, `{name}` for
// parameters. Every user-facing string in the web app lives here.
export const en = {
  app: {
    tagline: 'Verified, polished demo videos of the features you ship.',
    shell: {
      title: 'Your projects',
      signedInAs: 'Signed in as {email}',
      empty: 'Projects will appear here.',
      signOut: 'Sign out',
      signingOut: 'Signing out…',
      verifyTitle: 'Verify your email',
      verifyBody: 'We sent a link to {email}. Open it to finish setting up.',
      resend: 'Resend email',
      resending: 'Sending…',
      resent: 'Verification email sent. Check your inbox.',
      settings: 'Account settings',
    },
    settings: {
      title: 'Account settings',
      back: 'Back to your projects',
      email: 'Email',
      github: {
        title: 'GitHub',
        linked: 'Linked. You can sign in with GitHub.',
        notLinked: 'Not linked',
        unavailable: 'GitHub sign-in is not available yet.',
        link: 'Link GitHub',
        unlink: 'Unlink GitHub',
        unlinking: 'Unlinking…',
        unlinked: 'GitHub is unlinked.',
        needsPassword:
          'You sign in only with GitHub. To unlink it, first set a password with “Forgot your password?” on the sign-in page.',
      },
    },
  },
  meta: {
    title: 'DemoFlow',
  },
  home: {
    title: 'DemoFlow',
  },
  auth: {
    fields: {
      email: 'Email',
      password: 'Password',
      newPassword: 'New password',
      passwordHint: '10 to 128 characters.',
    },
    errors: {
      email: 'Enter a valid email address.',
      password: 'Use 10 to 128 characters.',
      passwordRequired: 'Enter your password.',
      credentials: 'Wrong email or password.',
      invalid: 'Something in the form is not valid. Check it and try again.',
      rateLimited: 'Too many attempts, try again later.',
      unknown: 'Something went wrong. Try again.',
    },
    github: {
      continue: 'Continue with GitHub',
      or: 'or',
      errors: {
        noVerifiedEmail:
          'Your GitHub account has no verified primary email. Verify one on GitHub, then try again.',
        linkRequiresVerified:
          'An account with this email exists but its email is not verified yet. Sign in with your password, then link GitHub from account settings.',
        alreadyLinkedElsewhere:
          'That GitHub account is already linked to another DemoFlow account.',
        alreadyLinked:
          'This DemoFlow account is already linked to a different GitHub account.',
        stateInvalid:
          'The GitHub sign-in expired or was started in another browser. Try again.',
        denied: 'GitHub sign-in was cancelled.',
        failed: 'GitHub did not answer. Try again in a moment.',
      },
    },
    signUp: {
      title: 'Create your account',
      submit: 'Create account',
      submitting: 'Creating account…',
      haveAccount: 'Already have an account?',
      signInLink: 'Sign in',
      doneTitle: 'Check your email',
      doneBody: 'We sent a verification link to {email}.',
    },
    signIn: {
      title: 'Sign in',
      submit: 'Sign in',
      submitting: 'Signing in…',
      noAccount: 'New to DemoFlow?',
      signUpLink: 'Create an account',
      forgot: 'Forgot your password?',
    },
    verify: {
      title: 'Verify your email',
      pending: 'Verifying your email…',
      doneTitle: 'Email verified',
      doneBody: 'Your email address is confirmed.',
      toApp: 'Go to the app',
      invalidTitle: 'This link is not valid',
      invalidBody: 'It may have expired or already been used.',
      resend: 'Send a new link',
      resent: 'A new link is on its way.',
      signIn: 'Sign in to request a new link',
    },
    forgot: {
      title: 'Reset your password',
      submit: 'Send reset link',
      submitting: 'Sending…',
      done: 'If an account exists for that address, we sent a link to reset the password.',
      back: 'Back to sign in',
    },
    reset: {
      title: 'Choose a new password',
      submit: 'Change password',
      submitting: 'Changing password…',
      doneTitle: 'Password changed',
      doneBody: 'Sign in with your new password.',
      signIn: 'Go to sign in',
      invalidTitle: 'This link is not valid',
      invalidBody: 'It may have expired or already been used.',
      requestNew: 'Request a new link',
    },
  },
} as const;
