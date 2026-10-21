import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsNotEmpty,
  IsString,
  Length,
  MaxLength,
} from 'class-validator';
import { normalizeEmail } from './email';

// NIST SP 800-63B: length only, no composition rules. `Length` counts a
// surrogate pair as one character, so the bounds are in code points.
const PASSWORD_MIN = 10;
const PASSWORD_MAX = 128;

class EmailField {
  @Transform(({ value }) => normalizeEmail(value))
  @IsEmail()
  @MaxLength(254)
  email!: string;
}

export class SignUpDto extends EmailField {
  @IsString()
  @Length(PASSWORD_MIN, PASSWORD_MAX)
  password!: string;
}

export class SignInDto extends EmailField {
  // No minimum: an old or wrong password is a 401, not a validation error.
  @IsString()
  @IsNotEmpty()
  @MaxLength(PASSWORD_MAX)
  password!: string;
}

export class PasswordResetRequestDto extends EmailField {}

export class EmailTokenDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  token!: string;
}

export class PasswordResetConfirmDto extends EmailTokenDto {
  @IsString()
  @Length(PASSWORD_MIN, PASSWORD_MAX)
  password!: string;
}
