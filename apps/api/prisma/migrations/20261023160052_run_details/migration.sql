-- AlterTable
ALTER TABLE "Run" ADD COLUMN     "failureMessage" TEXT,
ADD COLUMN     "failureStage" TEXT,
ADD COLUMN     "renders" JSONB,
ADD COLUMN     "stages" JSONB;
