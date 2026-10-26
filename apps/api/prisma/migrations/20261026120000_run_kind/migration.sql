-- CreateEnum
CREATE TYPE "RunKind" AS ENUM ('check');

-- AlterTable
ALTER TABLE "Run" ADD COLUMN     "kind" "RunKind";
