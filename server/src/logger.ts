import { randomUUID } from "crypto";
import type { NextFunction, Request, Response } from "express";
import { noteAlert, recordHttp, recordLog } from "./monitoring";

type LogLevel = "info" | "warn" | "error";
type LogContext = Record<string, unknown>;

type RequestWithId = Request & { requestId?: string };

export function log(level: LogLevel, event: string, context: LogContext = {}) {
  recordLog(level, event);
  const entry = {
    ts: new Date().toISOString(),
    level,
    event,
    ...context,
  };
  if (level !== "info") {
    noteAlert(level, event, context);
  }

  const line = JSON.stringify(entry);
  if (level === "error") {
    console.error(line);
    return;
  }

  console.log(line);
}

export function requestLogger(req: Request, res: Response, next: NextFunction) {
  const requestId = req.header("x-request-id") || randomUUID();
  (req as RequestWithId).requestId = requestId;
  res.setHeader("x-request-id", requestId);

  const startedAt = Date.now();
  res.on("finish", () => {
    const durationMs = Date.now() - startedAt;
    const level: LogLevel = res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info";
    recordHttp(res.statusCode, durationMs);
    log(level, "http.request", {
      requestId,
      method: req.method,
      path: req.originalUrl,
      statusCode: res.statusCode,
      durationMs,
      ip: req.ip,
      userAgent: req.get("user-agent") || "unknown",
    });
  });

  next();
}

export function getRequestId(req: Request) {
  return (req as RequestWithId).requestId || "unknown";
}

export function replyError(req: Request, res: Response, statusCode: number, error: string, context: LogContext = {}) {
  const requestId = getRequestId(req);
  const level: LogLevel = statusCode >= 500 ? "error" : "warn";
  log(level, "api.error", { requestId, statusCode, error, ...context });
  return res.status(statusCode).json({ error, requestId });
}
