// server/src/jwt.ts
import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";
const EXPIRES_IN = "7d";

export function signToken(username: string) {
  return jwt.sign({ username }, JWT_SECRET, { expiresIn: EXPIRES_IN });
}

export function verifyToken(token: string): { username: string } {
  const payload = jwt.verify(token, JWT_SECRET) as any;
  return { username: String(payload.username) };
}
