import { Transform } from 'class-transformer';
import { IsOptional, IsString, Length, ValidateIf } from 'class-validator';
import { IsGithubUrl, PATH_MAX, PROJECT_NAME_MAX } from '../projects.dto';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/** `POST /projects/folders/inspect` and `/init` (spec #378, Decision 1). */
export class FolderDto {
  @IsString()
  @Length(1, 64)
  runnerId!: string;

  /** As the person typed it: the machine resolves it, and only its answer is stored. */
  @IsString()
  @Length(1, PATH_MAX)
  path!: string;
}

/**
 * `POST /projects/folders/register`. Without `name`, the folder's name; without
 * `githubUrl`, the inspection's; `githubUrl: null` stores none.
 */
export class RegisterFolderDto extends FolderDto {
  // Not `@IsOptional()`: `null` is no second spelling of the default.
  @ValidateIf((_, value) => value !== undefined)
  @Transform(trim)
  @IsString()
  @Length(1, PROJECT_NAME_MAX)
  name?: string;

  @IsOptional()
  @IsGithubUrl()
  githubUrl?: string | null;
}
