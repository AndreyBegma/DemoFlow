import { IsIn, IsOptional, IsString, Length } from 'class-validator';
import { RUN_FORMATS, type RunFormat } from '../projects/projects.dto';

/** `DELETE /runs/:id` (spec #280, Decision 1). */
export class RunIdParamsDto {
  @IsString()
  @Length(1, 64)
  id!: string;
}

export class RunVideoParamsDto {
  @IsString()
  @Length(1, 64)
  id!: string;

  @IsIn(RUN_FORMATS)
  format!: RunFormat;
}

/** `?download=1` saves the file instead of playing it (spec #299, Decision 2). */
export class RunVideoQueryDto {
  @IsOptional()
  @IsIn(['1'])
  download?: '1';
}
