import { Injectable } from '@nestjs/common';
import { hash, verify } from '@node-rs/argon2';
import { generateToken } from './tokens';

/** argon2id with the library's defaults (ADR-0006). */
@Injectable()
export class PasswordHasher {
  // Verified against when there is no user or no password, so a failed
  // sign-in costs the same whether the email exists or not.
  private dummyHash: Promise<string> | undefined;

  hash(password: string): Promise<string> {
    return hash(password);
  }

  async verify(
    passwordHash: string | null,
    password: string,
  ): Promise<boolean> {
    if (passwordHash === null) {
      this.dummyHash ??= hash(generateToken());
      await verify(await this.dummyHash, password);
      return false;
    }
    return verify(passwordHash, password);
  }
}
