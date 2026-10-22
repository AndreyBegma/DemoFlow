import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import type { GithubIntent } from './oauth-cookie';

export class GithubStartDto {
  @IsIn(['sign-in', 'link'])
  intent!: GithubIntent;
}

/**
 * Everything GitHub may append to the callback. All optional: a denial comes
 * back with `error` and no `code`, and must still redirect, not 400.
 */
export class GithubCallbackDto {
  @IsOptional()
  @IsString()
  @MaxLength(512)
  code?: string;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  state?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  error?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1024)
  error_description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1024)
  error_uri?: string;
}
