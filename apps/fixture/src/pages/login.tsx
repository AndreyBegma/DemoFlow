import { Button } from '@andrewbehma/glass-ui/button';
import { Field, Input } from '@andrewbehma/glass-ui/field';
import { type FormEvent, useState } from 'react';

const MIN_PASSWORD_LENGTH = 8;

export function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [signedInAs, setSignedInAs] = useState<string | null>(null);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError('Password too short');
      return;
    }
    setError('');
    setSignedInAs(email);
  }

  if (signedInAs !== null) {
    return (
      <section>
        <h1 className="text-2xl font-semibold">Welcome, {signedInAs}</h1>
      </section>
    );
  }

  return (
    <section>
      <h1 className="text-2xl font-semibold">Login</h1>
      <form onSubmit={submit} className="mt-4 flex max-w-sm flex-col gap-3">
        <Field label="Email" htmlFor="login-email">
          <Input
            id="login-email"
            type="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </Field>
        <Field label="Password" htmlFor="login-password" error={error}>
          <Input
            id="login-password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </Field>
        <Button type="submit">Sign in</Button>
      </form>
    </section>
  );
}
