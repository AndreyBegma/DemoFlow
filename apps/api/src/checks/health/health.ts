import type { Prisma, RunStatus } from '@prisma/client';

/** A stored run, as the stale state needs it. */
export interface HealthRun {
  id: string;
  scenarioPath: string;
  status: RunStatus;
  startedAt: Date;
}

/**
 * Moves a scenario's state on after a stored run (spec #362, Decision 6):
 * same state → only `lastRunId`; another state → `state`, `since` and
 * `lastRunId`. A run that started before the one the state comes from is
 * older news and changes nothing. Called inside the report's transaction.
 */
export async function recordHealth(
  tx: Prisma.TransactionClient,
  projectId: string,
  run: HealthRun,
): Promise<void> {
  const key = {
    projectId_scenarioPath: { projectId, scenarioPath: run.scenarioPath },
  };
  const created = await tx.$executeRaw`
    INSERT INTO "ScenarioHealth" ("projectId", "scenarioPath", "state", "since", "lastRunId")
    VALUES (${projectId}, ${run.scenarioPath}, ${run.status}::"RunStatus", ${run.startedAt}, ${run.id})
    ON CONFLICT ("projectId", "scenarioPath") DO NOTHING`;
  if (created === 1) {
    return;
  }
  // Locks the row, so two reports of one scenario apply one after the other.
  const [row] = await tx.$queryRaw<
    { state: RunStatus; lastRunId: string }[]
  >`SELECT "state", "lastRunId" FROM "ScenarioHealth"
    WHERE "projectId" = ${projectId} AND "scenarioPath" = ${run.scenarioPath}
    FOR UPDATE`;
  if (!row) {
    return;
  }
  const last = await tx.run.findUnique({
    where: { id: row.lastRunId },
    select: { startedAt: true },
  });
  if (last && last.startedAt > run.startedAt) {
    return;
  }
  await tx.scenarioHealth.update({
    where: key,
    data:
      row.state === run.status
        ? { lastRunId: run.id }
        : { state: run.status, since: run.startedAt, lastRunId: run.id },
  });
}

/**
 * Recomputes a project's states from its runs, as the migration's backfill
 * does: each scenario's latest run gives the state, and `since` is the start
 * of the oldest run after the latest run with the other status. Used when a
 * merge moves another project's runs here.
 */
export async function rebuildHealth(
  tx: Prisma.TransactionClient,
  projectId: string,
): Promise<void> {
  await tx.scenarioHealth.deleteMany({ where: { projectId } });
  await tx.$executeRaw`
    INSERT INTO "ScenarioHealth" ("projectId", "scenarioPath", "state", "since", "lastRunId")
    SELECT
      latest."projectId",
      latest."scenarioPath",
      latest."status",
      COALESCE((
        SELECT MIN(r."startedAt")
        FROM "Run" r
        WHERE r."projectId" = latest."projectId"
          AND r."scenarioPath" = latest."scenarioPath"
          AND r."startedAt" > COALESCE(
            (
              SELECT MAX(o."startedAt")
              FROM "Run" o
              WHERE o."projectId" = latest."projectId"
                AND o."scenarioPath" = latest."scenarioPath"
                AND o."status" <> latest."status"
            ),
            '-infinity'::timestamp
          )
      ), latest."startedAt"),
      latest."id"
    FROM (
      SELECT DISTINCT ON ("scenarioPath")
        "projectId", "scenarioPath", "status", "startedAt", "id"
      FROM "Run"
      WHERE "projectId" = ${projectId}
      ORDER BY "scenarioPath", "startedAt" DESC, "id" DESC
    ) latest`;
}
