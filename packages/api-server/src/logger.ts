import { randomUUID } from 'crypto';
import { Request, Response, NextFunction } from 'express';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  requestId?: string;
  method?: string;
  path?: string;
  statusCode?: number;
  durationMs?: number;
  error?: string;
  stack?: string;
  [key: string]: unknown;
}

const LOG_LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

const minLevel: LogLevel = (process.env.LOG_LEVEL as LogLevel) || 'info';

function emit(entry: LogEntry): void {
  if (LOG_LEVELS[entry.level] < LOG_LEVELS[minLevel]) return;
  const stream = entry.level === 'error' ? process.stderr : process.stdout;
  stream.write(JSON.stringify(entry) + '\n');
}

function formatError(err: unknown): Pick<LogEntry, 'error' | 'stack'> {
  if (err instanceof Error) {
    return { error: err.message, stack: err.stack };
  }
  return { error: String(err) };
}

export const logger = {
  debug(message: string, extra?: Record<string, unknown>) {
    emit({ timestamp: new Date().toISOString(), level: 'debug', message, ...extra });
  },
  info(message: string, extra?: Record<string, unknown>) {
    emit({ timestamp: new Date().toISOString(), level: 'info', message, ...extra });
  },
  warn(message: string, extra?: Record<string, unknown>) {
    emit({ timestamp: new Date().toISOString(), level: 'warn', message, ...extra });
  },
  error(message: string, err?: unknown, extra?: Record<string, unknown>) {
    emit({ timestamp: new Date().toISOString(), level: 'error', message, ...formatError(err), ...extra });
  },
};

declare module 'express-serve-static-core' {
  interface Request {
    requestId?: string;
  }
}

export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const requestId = (req.headers['x-request-id'] as string) || randomUUID();
  const start = Date.now();

  req.requestId = requestId;
  res.setHeader('x-request-id', requestId);

  res.on('finish', () => {
    const durationMs = Date.now() - start;
    const level: LogLevel = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';

    emit({
      timestamp: new Date().toISOString(),
      level,
      message: 'request',
      requestId,
      method: req.method,
      path: req.originalUrl,
      statusCode: res.statusCode,
      durationMs,
      userAgent: req.headers['user-agent'],
      ip: req.ip,
      contentLength: Number(req.headers['content-length']) || undefined,
      apiKeyId: req.apiKeyId,
    });
  });

  next();
}
