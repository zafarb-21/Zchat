// server/src/db.ts
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// Export BOTH ways so any import style works reliably
export { prisma };
export default prisma;
