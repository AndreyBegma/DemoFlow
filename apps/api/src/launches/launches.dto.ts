import { IsScenarioId } from './scenario-id';

/** `POST /projects/:id/launch` (spec #247, Decision 2): the scenario, nothing else. */
export class StartLaunchDto {
  @IsScenarioId()
  scenarioId!: string;
}
