export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const levelRank: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

function parseLevel(value: string | undefined): LogLevel {
  const v = (value || 'info').toLowerCase();
  if (v === 'debug' || v === 'info' || v === 'warn' || v === 'error') return v;
  return 'info';
}

const currentLevel: LogLevel = parseLevel(process.env.LOG_LEVEL);

function shouldLog(level: LogLevel): boolean {
  return levelRank[level] >= levelRank[currentLevel];
}

function nowIso(): string {
  return new Date().toISOString();
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '"[unserializable]"';
  }
}

function emit(level: LogLevel, message: string, meta?: unknown): void {
  if (!shouldLog(level)) return;
  const line = meta === undefined ? message : `${message} ${safeJson(meta)}`;
  // PM2 captures stdout/stderr; keep output single-line and timestamped.
  // eslint-disable-next-line no-console
  console.log(`${nowIso()} [${level.toUpperCase()}] ${line}`);
}

export const logger = {
  debug: (message: string, meta?: unknown) => emit('debug', message, meta),
  info: (message: string, meta?: unknown) => emit('info', message, meta),
  warn: (message: string, meta?: unknown) => emit('warn', message, meta),
  error: (message: string, meta?: unknown) => emit('error', message, meta)
};

