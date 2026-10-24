import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsIn,
  ValidateIf,
} from 'class-validator';
import { RUN_FORMATS, type RunFormat } from '../projects/projects.dto';
import { IsScenarioId } from './scenario-id';

/**
 * `POST /projects/:id/launch` (spec #247, Decision 2): the scenario, and the
 * output formats when the browser chose them (spec #325, Decision 1).
 */
export class StartLaunchDto {
  @IsScenarioId()
  scenarioId!: string;

  /**
   * In render order; absent means the project's own. Not `@IsOptional()`:
   * that would let `null` through as a second spelling of the default.
   */
  @ValidateIf((_, value) => value !== undefined)
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(RUN_FORMATS.length)
  @ArrayUnique()
  @IsIn(RUN_FORMATS, { each: true })
  formats?: RunFormat[];
}
