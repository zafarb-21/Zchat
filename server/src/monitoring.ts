type CounterMap = Record<string, number>;

type AlertEntry = {
  ts: string;
  level: "warn" | "error";
  event: string;
  context: Record<string, unknown>;
};

const startedAt = Date.now();
const counters: CounterMap = {};
const alerts: AlertEntry[] = [];

function bump(key: string) {
  counters[key] = (counters[key] || 0) + 1;
}

export function recordLog(level: "info" | "warn" | "error", event: string) {
  bump(`log.${level}`);
  bump(`event.${event}`);
}

export function recordHttp(statusCode: number, durationMs: number) {
  bump("http.total");
  if (statusCode >= 500) bump("http.5xx");
  else if (statusCode >= 400) bump("http.4xx");
  else if (statusCode >= 200) bump("http.2xx");

  if (durationMs >= 2000) bump("http.slow");
}

export function noteAlert(level: "warn" | "error", event: string, context: Record<string, unknown>) {
  alerts.unshift({
    ts: new Date().toISOString(),
    level,
    event,
    context,
  });
  if (alerts.length > 100) alerts.length = 100;
}

export function metricsSnapshot() {
  return {
    startedAt,
    uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
    counters,
    recentAlerts: alerts.slice(0, 20),
  };
}
