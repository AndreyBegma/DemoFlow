-- CreateTable
CREATE TABLE "GithubIdentity" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "githubUserId" TEXT NOT NULL,
    "login" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GithubIdentity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GithubIdentity_userId_key" ON "GithubIdentity"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "GithubIdentity_githubUserId_key" ON "GithubIdentity"("githubUserId");

-- AddForeignKey
ALTER TABLE "GithubIdentity" ADD CONSTRAINT "GithubIdentity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
