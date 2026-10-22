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
      machines: 'Machines',
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
  device: {
    back: 'Back to your projects',
    code: {
      title: 'Pair a machine',
      body: 'Run demoflow login in a terminal and enter the code it prints.',
      label: 'Code',
      placeholder: 'ABCD-1234',
      submit: 'Continue',
      invalid: 'Enter the 8-character code from your terminal.',
    },
    notFound: {
      title: 'This code is not valid',
      body: 'It may have expired, been used, or been mistyped. Run demoflow login again for a new one.',
    },
    unavailable: 'We could not load this code. Try again in a moment.',
    verify: {
      title: 'Verify your email first',
      body: 'Only a verified account can pair a machine. We sent a link to {email}.',
      resend: 'Resend email',
      resent: 'Verification email sent. Check your inbox.',
    },
    approve: {
      title: 'Approve this machine?',
      code: 'Code',
      hostname: 'Machine',
      os: 'System',
      cliVersion: 'CLI version',
      requested: 'Requested',
      warning:
        'Check that this code matches the one in your terminal. If you did not run demoflow login, deny it.',
      nameLabel: 'Name',
      nameHint: '1 to 64 characters. You can rename it later.',
      submit: 'Approve',
      submitting: 'Approving…',
      deny: 'Deny',
      denying: 'Denying…',
    },
    errors: {
      name: 'Enter a name of 1 to 64 characters.',
      limit:
        'You already have 20 paired machines. Revoke one, then approve again.',
      notFound: 'This code has expired or was already used.',
      notVerified: 'Verify your email before approving a machine.',
    },
    done: {
      approvedTitle: 'Machine approved',
      approvedBody: 'Return to your terminal. It will finish signing in.',
      deniedTitle: 'Request denied',
      deniedBody: 'The machine was not paired.',
      machines: 'Go to machines',
    },
  },
  machines: {
    title: 'Machines',
    back: 'Back to your projects',
    empty: {
      title: 'No machines paired yet',
      body: 'Run this in a terminal on the machine you want to pair:',
      command: 'npx demoflow login',
      afterLogin: 'Then keep it connected with:',
    },
    columns: {
      name: 'Name',
      os: 'System',
      cliVersion: 'CLI',
      paired: 'Paired',
      status: 'Status',
      lastSeen: 'Last seen',
      lastUsed: 'Last used',
      actions: 'Actions',
    },
    neverUsed: 'Never',
    status: {
      online: 'Online',
      offline: 'Offline',
    },
    lastSeen: {
      never: 'Never connected',
      justNow: 'just now',
      ip: 'from {ip}',
    },
    noneOnline: 'No machine is online. Run this on a paired machine:',
    startCommand: 'demoflow runner start',
    rename: 'Rename',
    renameLabel: 'Machine name',
    save: 'Save',
    saving: 'Saving…',
    cancel: 'Cancel',
    revoke: 'Revoke',
    revokeTitle: 'Revoke “{name}”?',
    revokeBody:
      'The machine is signed out at once and must run demoflow login to pair again.',
    errors: {
      name: 'Enter a name of 1 to 64 characters.',
      notFound: 'This machine is already gone. The list was refreshed.',
    },
    loadFailed: 'We could not load your machines. Try again in a moment.',
  },
  meta: {
    title: 'DemoFlow',
  },
  home: {
    title: 'DemoFlow',
  },
  landing: {
    meta: {
      title: 'DemoFlow — demo videos from one JSON scenario',
      description:
        'DemoFlow drives your running app in a real browser, checks every step and renders a polished demo video. Everything runs on your machine.',
      imageAlt: 'A DemoFlow demo video of a sample app',
    },
    nav: {
      label: 'Main',
      home: 'DemoFlow home',
      docs: 'Docs',
      signIn: 'Sign in',
      openApp: 'Open app',
    },
    hero: {
      title: 'Demo videos of the features you ship, from one JSON scenario.',
      subtitle:
        'DemoFlow drives your running app in a real browser, checks every step, and renders a polished video (MP4, GIF or WebM) with a drawn cursor, zoom on the action and captions.',
    },
    video: {
      label: 'A demo video of a sample app, recorded with DemoFlow',
      caption: 'This video was made with DemoFlow from a short JSON scenario.',
    },
    benefits: {
      title: 'Why DemoFlow',
      write: {
        title: 'Write it, or let an agent write it',
        body: 'Describe a flow in a short JSON scenario, or let an AI agent such as Claude Code write and run it over MCP. Out comes a finished video.',
      },
      secrets: {
        title: 'Secrets stay masked',
        body: 'Passwords come from environment variables, never touch disk or logs, and are blurred in the video by construction.',
      },
      local: {
        title: 'Your videos stay on your machine',
        body: 'The browser, your app and your secrets never leave your computer. DemoFlow runs locally or in your own CI.',
      },
    },
    install: {
      title: 'Run it in your project',
      command: 'npx demoflow',
      body: 'Then run demoflow record to capture a scenario by clicking through your app.',
      copy: 'Copy command',
      copied: 'Copied',
      copyFailed: 'Could not copy. Select the command and copy it.',
    },
    footer: {
      license: 'DemoFlow · MIT licence',
      github: 'GitHub',
      docs: 'Docs',
    },
  },
  docs: {
    meta: {
      title: 'Documentation',
    },
    header: {
      home: 'DemoFlow home',
      openApp: 'Open app',
    },
    nav: {
      label: 'Documentation',
      title: 'Docs',
      start: 'Getting started',
      scenarios: 'Scenarios',
      config: 'Project config',
      cli: 'CLI',
      record: 'Recording',
      runner: 'Runner',
      mcp: 'MCP tools',
      more: 'More guides',
    },
    toc: {
      label: 'On this page',
    },
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
