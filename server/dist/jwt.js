"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.signToken = signToken;
exports.verifyToken = verifyToken;
// server/src/jwt.ts
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";
const EXPIRES_IN = "7d";
function signToken(username) {
    return jsonwebtoken_1.default.sign({ username }, JWT_SECRET, { expiresIn: EXPIRES_IN });
}
function verifyToken(token) {
    const payload = jsonwebtoken_1.default.verify(token, JWT_SECRET);
    return { username: String(payload.username) };
}
