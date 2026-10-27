import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsIn,
  Matches,
  ValidateBy,
  ValidateIf,
} from 'class-validator';
import { IsScenarioId } from '../../launches/scenario-id';
import { CADENCES, type Cadence, TIME_OF_DAY, WEEKDAYS } from '../slots';
import { IsTimeZone } from './time-zone';

/** At most this many scenarios left out of a pass (spec #362, Decision 3). */
export const MAX_EXCLUDES = 100;

/** `PUT /projects/:id/schedule`: the website's schedule of a project. */
export class PutScheduleDto {
  @IsIn(CADENCES)
  cadence!: Cadence;

  /** Required with `weekly`, refused with any other cadence. */
  @ValidateIf(
    (dto: PutScheduleDto, value) =>
      dto.cadence === 'weekly' || value !== undefined,
  )
  @IsIn(WEEKDAYS)
  @ValidateBy({
    name: 'onlyWithWeekly',
    validator: {
      validate: (_, args) =>
        (args?.object as PutScheduleDto).cadence === 'weekly',
      defaultMessage: () => 'weekday is only allowed with the weekly cadence',
    },
  })
  weekday?: string;

  @Matches(TIME_OF_DAY, { message: 'at must be HH:MM, 24-hour' })
  at!: string;

  @IsTimeZone()
  timeZone!: string;

  @ValidateIf((_, value) => value !== undefined)
  @IsArray()
  @ArrayMaxSize(MAX_EXCLUDES)
  @ArrayUnique()
  @IsScenarioId({ each: true })
  exclude?: string[];
}
