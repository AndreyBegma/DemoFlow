import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Length,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export const PROJECT_NAME_MAX = 200;
export const PATH_MAX = 4096;

/** `RENDER_FORMATS` of `@demoflow/core`, which the API does not depend on. */
export const RUN_FORMATS = ['mp4', 'gif', 'webm', 'mp4-vertical'] as const;
export type RunFormat = (typeof RUN_FORMATS)[number];
export const RUN_STATUSES = ['passed', 'failed'] as const;

/** What `demoflow run` sends after a run on a paired machine (spec #178, Decision 3). */
export class RunReportDto {
  /** The absolute path of the project root, as the CLI resolved it. */
  @IsString()
  @Length(1, PATH_MAX)
  rootPath!: string;

  /** The config's `name`, else the root's basename. Used only for a new project. */
  @Transform(trim)
  @IsString()
  @Length(1, PROJECT_NAME_MAX)
  projectName!: string;

  @Transform(trim)
  @IsString()
  @Length(1, PROJECT_NAME_MAX)
  scenarioName!: string;

  /** Relative to `rootPath`. */
  @IsString()
  @Length(1, PATH_MAX)
  scenarioPath!: string;

  @IsIn(RUN_STATUSES)
  status!: (typeof RUN_STATUSES)[number];

  @IsISO8601({ strict: true })
  startedAt!: string;

  @IsInt()
  @Min(0)
  @Max(2_147_483_647)
  durationMs!: number;

  /** Empty when nothing was rendered. */
  @IsArray()
  @ArrayMaxSize(RUN_FORMATS.length)
  @ArrayUnique()
  @IsIn(RUN_FORMATS, { each: true })
  formats!: RunFormat[];

  /** The 0-based index of the failed step. */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(2_147_483_647)
  failedStep?: number;

  @Transform(trim)
  @IsString()
  @Length(1, 64)
  cliVersion!: string;
}

export class CreateProjectDto {
  @Transform(trim)
  @IsString()
  @Length(1, PROJECT_NAME_MAX)
  name!: string;
}

/** Renames and binds. `runnerId` and `rootPath` come together or not at all. */
export class UpdateProjectDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, PROJECT_NAME_MAX)
  name?: string;

  @ValidateIf((dto: UpdateProjectDto) => dto.rootPath !== undefined)
  @IsString()
  @Length(1, 64)
  runnerId?: string;

  @ValidateIf((dto: UpdateProjectDto) => dto.runnerId !== undefined)
  @IsString()
  @Length(1, PATH_MAX)
  rootPath?: string;
}

export class RunsPageQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  cursor?: string;
}
