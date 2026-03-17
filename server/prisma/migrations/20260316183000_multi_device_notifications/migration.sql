ALTER TABLE "Message"
ADD COLUMN IF NOT EXISTS "fromDeviceId" TEXT NOT NULL DEFAULT 'legacy';

CREATE TABLE IF NOT EXISTS "UserDevice" (
    "id" TEXT NOT NULL,
    "userUsername" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "deviceLabel" TEXT NOT NULL,
    "publicKeyJwk" JSONB,
    "notificationsEnabled" BOOLEAN NOT NULL DEFAULT false,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserDevice_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "UserDevice_deviceId_key" ON "UserDevice"("deviceId");
CREATE INDEX IF NOT EXISTS "UserDevice_userUsername_lastSeenAt_idx" ON "UserDevice"("userUsername", "lastSeenAt");

ALTER TABLE "UserDevice"
ADD CONSTRAINT "UserDevice_userUsername_fkey"
FOREIGN KEY ("userUsername") REFERENCES "User"("username") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "MessageEnvelope" (
    "id" TEXT NOT NULL,
    "msgId" TEXT NOT NULL,
    "ownerUsername" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "bodyCiphertext" TEXT NOT NULL,
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MessageEnvelope_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "MessageEnvelope_msgId_deviceId_key" ON "MessageEnvelope"("msgId", "deviceId");
CREATE INDEX IF NOT EXISTS "MessageEnvelope_ownerUsername_deviceId_idx" ON "MessageEnvelope"("ownerUsername", "deviceId");
CREATE INDEX IF NOT EXISTS "MessageEnvelope_deviceId_deliveredAt_idx" ON "MessageEnvelope"("deviceId", "deliveredAt");

ALTER TABLE "MessageEnvelope"
ADD CONSTRAINT "MessageEnvelope_msgId_fkey"
FOREIGN KEY ("msgId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MessageEnvelope"
ADD CONSTRAINT "MessageEnvelope_ownerUsername_fkey"
FOREIGN KEY ("ownerUsername") REFERENCES "User"("username") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "MessageEnvelope"
ADD CONSTRAINT "MessageEnvelope_deviceId_fkey"
FOREIGN KEY ("deviceId") REFERENCES "UserDevice"("deviceId") ON DELETE CASCADE ON UPDATE CASCADE;
