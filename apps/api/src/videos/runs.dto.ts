import { IsIn, IsString, Length } from 'class-validator';
import { RUN_FORMATS, type RunFormat } from '../projects/projects.dto';

export class RunVideoParamsDto {
  @IsString()
  @Length(1, 64)
  id!: string;

  @IsIn(RUN_FORMATS)
  format!: RunFormat;
}
