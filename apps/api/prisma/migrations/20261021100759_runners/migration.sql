-- CreateTable
CREATE TABLE "Runner" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "os" TEXT NOT NULL,
    "cliVersion" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "Runner_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceCode" (
    "id" TEXT NOT NULL,
    "deviceCodeHash" TEXT NOT NULL,
    "userCode" TEXT NOT NULL,
    "hostname" TEXT NOT NULL,
    "os" TEXT NOT NULL,
    "cliVersion" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "lastPolledAt" TIMESTAMP(3),
    "approvedAt" TIMESTAMP(3),
    "deniedAt" TIMESTAMP(3),
    "approvedById" TEXT,
    "runnerName" TEXT,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeviceCode_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Runner_tokenHash_key" ON "Runner"("tokenHash");

-- CreateIndex
CREATE INDEX "Runner_userId_idx" ON "Runner"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "DeviceCode_deviceCodeHash_key" ON "DeviceCode"("deviceCodeHash");

-- CreateIndex
CREATE UNIQUE INDEX "DeviceCode_userCode_key" ON "DeviceCode"("userCode");

-- AddForeignKey
ALTER TABLE "Runner" ADD CONSTRAINT "Runner_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
