export type LogTag =
  | 'FETCH'
  | 'FILTER'
  | 'LOCAL-LLM'
  | 'CLOUD-LLM'
  | 'DB'
  | 'EXPORT'
  | 'ERROR'
  | 'RUN'
  | 'ROBOTS'
  | 'BROWSER'
  | 'CACHE';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * Patterns for things that must never reach a log line, a file, or a terminal.
 * Applied to every message and every serialised field.
 */
const SECRET_PATTERNS: RegExp[] = [
  /sk-or-v1-[A-Za-z0-9_-]{8,}/g, // OpenRouter
  /sk-[A-Za-z0-9]{20,}/g, // OpenAI-style
  /AIza[A-Za-z0-9_-]{20,}/g, // Google API key
  /AQ\.[A-Za-z0-9_-]{20,}/g, // Google short-lived credential
  /ghp_[A-Za-z0-9]{20,}/g, // GitHub
  /Bearer\s+[A-Za-z0-9._-]{12,}/gi,
  // userinfo in any URL — a proxy, a self-hosted Ollama behind basic auth, or
  // any other endpoint someone puts credentials into.
  /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/gi,
];

export function redact(input: string): string {
  let out = input;
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, '[REDACTED]');
  return out;
}

export function serialise(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Shared by createLogger and any custom logger, so filtering cannot drift. */
export function shouldLog(level: LogLevel, minimum: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[minimum];
}

export interface Logger {
  debug(tag: LogTag, message: string, meta?: unknown): void;
  info(tag: LogTag, message: string, meta?: unknown): void;
  warn(tag: LogTag, message: string, meta?: unknown): void;
  error(tag: LogTag, message: string, meta?: unknown): void;
  /** Plain line, no tag or timestamp — used for the human-facing run summary. */
  plain(message?: string): void;
}

export function createLogger(level: LogLevel = 'info'): Logger {
  const emit = (lvl: LogLevel, tag: LogTag, message: string, meta?: unknown) => {
    if (!shouldLog(lvl, level)) return;
    const ts = new Date().toISOString();
    const metaText = meta === undefined ? '' : ` ${serialise(meta)}`;
    const line = redact(`${ts} [${tag}] ${message}${metaText}`);
    if (lvl === 'error' || lvl === 'warn') console.error(line);
    else console.log(line);
  };

  return {
    debug: (t, m, x) => emit('debug', t, m, x),
    info: (t, m, x) => emit('info', t, m, x),
    warn: (t, m, x) => emit('warn', t, m, x),
    error: (t, m, x) => emit('error', t, m, x),
    plain: (m = '') => console.log(redact(m)),
  };
}

/** A logger that records instead of printing — used in tests. */
export function createSilentLogger(): Logger & { lines: string[] } {
  const lines: string[] = [];
  const push = (tag: LogTag, m: string, x?: unknown) =>
    lines.push(redact(`[${tag}] ${m}${x === undefined ? '' : ` ${serialise(x)}`}`));
  return {
    lines,
    debug: push,
    info: push,
    warn: push,
    error: push,
    plain: (m = '') => lines.push(redact(m)),
  };
}
