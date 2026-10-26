import { IsIn, IsOptional, IsString, Length } from 'class-validator';
import { SHARE_PASSWORD_MAX, SHARE_PASSWORD_MIN } from './shares.dto';

/** `POST /s/:token/unlock` (spec #348, Decision 5). */
export class UnlockShareDto {
  /** Never trimmed: a password is what the person typed. */
  @IsString()
  @Length(SHARE_PASSWORD_MIN, SHARE_PASSWORD_MAX)
  password!: string;
}

/** `?download=1` saves the file instead of playing it (Decision 4). */
export class ShareFileQueryDto {
  @IsOptional()
  @IsIn(['1'])
  download?: '1';
}
