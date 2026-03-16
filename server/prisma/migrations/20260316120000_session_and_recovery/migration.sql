ALTER TABLE "User"
ADD COLUMN IF NOT EXISTS "recoveryCodeHash" TEXT;

CREATE TABLE IF NOT EXISTS "PeerSession" (
    "id" TEXT NOT NULL,
    "peerKey" TEXT NOT NULL,
    "userA" TEXT NOT NULL,
    "userB" TEXT NOT NULL,
    "requestedBy" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "PeerSession_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "PeerSession_peerKey_key" ON "PeerSession"("peerKey");
CREATE INDEX IF NOT EXISTS "PeerSession_userA_status_idx" ON "PeerSession"("userA", "status");
CREATE INDEX IF NOT EXISTS "PeerSession_userB_status_idx" ON "PeerSession"("userB", "status");
