-- CreateEnum
CREATE TYPE "ProjectSource" AS ENUM ('reported', 'website');

-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "githubUrl" TEXT,
ADD COLUMN     "source" "ProjectSource" NOT NULL DEFAULT 'reported';
