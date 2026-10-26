-- CreateEnum
CREATE TYPE "ScheduleSource" AS ENUM ('site', 'config');

-- CreateEnum
CREATE TYPE "ScheduleCadence" AS ENUM ('daily', 'weekdays', 'weekly');

-- CreateTable
CREATE TABLE "CheckSchedule" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "source" "ScheduleSource" NOT NULL,
    "cadence" "ScheduleCadence" NOT NULL,
    "weekday" TEXT,
    "at" TEXT NOT NULL,
    "timeZone" TEXT NOT NULL,
    "exclude" TEXT[],
    "pausedReason" TEXT,
    "lastSlotAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CheckSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScenarioHealth" (
    "projectId" TEXT NOT NULL,
    "scenarioPath" TEXT NOT NULL,
    "state" "RunStatus" NOT NULL,
    "since" TIMESTAMP(3) NOT NULL,
    "lastRunId" TEXT NOT NULL,

    CONSTRAINT "ScenarioHealth_pkey" PRIMARY KEY ("projectId","scenarioPath")
);

-- CreateIndex
CREATE UNIQUE INDEX "CheckSchedule_projectId_source_key" ON "CheckSchedule"("projectId", "source");

-- CreateIndex
CREATE INDEX "ScenarioHealth_projectId_state_idx" ON "ScenarioHealth"("projectId", "state");

-- AddForeignKey
ALTER TABLE "CheckSchedule" ADD CONSTRAINT "CheckSchedule_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScenarioHealth" ADD CONSTRAINT "ScenarioHealth_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: each scenario's state is its latest run's status, `since` the
-- start of the oldest run after the latest run with the other status.
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
    SELECT DISTINCT ON ("projectId", "scenarioPath")
        "projectId", "scenarioPath", "status", "startedAt", "id"
    FROM "Run"
    ORDER BY "projectId", "scenarioPath", "startedAt" DESC, "id" DESC
) latest;
