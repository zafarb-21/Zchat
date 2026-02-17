-- AlterTable
ALTER TABLE "User" ADD COLUMN     "keyUpdatedAt" TIMESTAMP(3),
ADD COLUMN     "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "publicKeyJwk" JSONB;

-- CreateTable
CREATE TABLE "Conversation" (
    "id" TEXT NOT NULL,
    "convKey" TEXT NOT NULL,
    "userA" TEXT NOT NULL,
    "userB" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "convId" TEXT NOT NULL,
    "fromUser" TEXT NOT NULL,
    "toUser" TEXT NOT NULL,
    "bodyCiphertext" TEXT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deliveredAt" TIMESTAMP(3),
    "readAt" TIMESTAMP(3),

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Conversation_convKey_key" ON "Conversation"("convKey");

-- CreateIndex
CREATE INDEX "Message_toUser_deliveredAt_idx" ON "Message"("toUser", "deliveredAt");

-- CreateIndex
CREATE INDEX "Message_convId_ts_idx" ON "Message"("convId", "ts");

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_convId_fkey" FOREIGN KEY ("convId") REFERENCES "Conversation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_fromUser_fkey" FOREIGN KEY ("fromUser") REFERENCES "User"("username") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_toUser_fkey" FOREIGN KEY ("toUser") REFERENCES "User"("username") ON DELETE RESTRICT ON UPDATE CASCADE;
