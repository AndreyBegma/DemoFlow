import { IsIn, IsOptional, IsString, IsUUID, Length } from 'class-validator';
import { RUN_FORMATS, type RunFormat } from '../projects/projects.dto';

/** A share's lifetime in days (spec #347, Decision 5). */
export const SHARE_LIFETIMES = [7, 30, 90] as const;
export type ShareLifetime = (typeof SHARE_LIFETIMES)[number];
export const DEFAULT_SHARE_LIFETIME: ShareLifetime = 30;

/** Decision 8. */
export const SHARE_PASSWORD_MIN = 8;
export const SHARE_PASSWORD_MAX = 128;

/** `POST /shares` and `POST /runner/shares`. */
export class CreateShareDto {
  @IsUUID()
  runId!: string;

  @IsIn(RUN_FORMATS)
  format!: RunFormat;

  @IsOptional()
  @IsIn(SHARE_LIFETIMES)
  expiresInDays?: ShareLifetime;

  /** Never trimmed: a password is what the person typed. */
  @IsOptional()
  @IsString()
  @Length(SHARE_PASSWORD_MIN, SHARE_PASSWORD_MAX)
  password?: string;
}

export class ShareIdParamsDto {
  @IsString()
  @Length(1, 64)
  id!: string;
}
