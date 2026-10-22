-- AlterTable
ALTER TABLE "Runner" ADD COLUMN     "lastSeenAt" TIMESTAMP(3),
ADD COLUMN     "lastSeenIp" TEXT,
ADD COLUMN     "pendingIssuedAt" TIMESTAMP(3),
ADD COLUMN     "pendingTokenHash" TEXT,
ADD COLUMN     "tokenIssuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Backfill: a token paired before this migration was issued when its machine
-- was created, so rotation measures its age from there (spec #151).
UPDATE "Runner" SET "tokenIssuedAt" = "createdAt";

-- CreateIndex
CREATE UNIQUE INDEX "Runner_pendingTokenHash_key" ON "Runner"("pendingTokenHash");
