import { createRedactor } from './redact.js';

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

export interface LoggerOptions {
  level?: LogLevel;
  /** Values that must never appear in logs (API key, derived auth header). */
  secrets?: readonly string[];
  /** Defaults to stderr: stdout carries the MCP stdio protocol and must stay clean. */
  write?: (line: string) => void;
}

/** Structured JSON-lines logger with secret redaction. */
export function createLogger(options: LoggerOptions = {}): Logger {
  const threshold = LOG_LEVELS.indexOf(options.level ?? 'info');
  const redact = createRedactor(options.secrets ?? []);
  const write = options.write ?? ((line: string) => process.stderr.write(`${line}\n`));

  const log = (level: LogLevel, message: string, fields?: LogFields): void => {
    if (LOG_LEVELS.indexOf(level) < threshold) return;
    const entry = { time: new Date().toISOString(), level, message, ...fields };
    write(redact(JSON.stringify(entry)));
  };

  return {
    debug: (message, fields) => log('debug', message, fields),
    info: (message, fields) => log('info', message, fields),
    warn: (message, fields) => log('warn', message, fields),
    error: (message, fields) => log('error', message, fields),
  };
}

export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};
