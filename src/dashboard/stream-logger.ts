import {
  redact,
  serialise,
  shouldLog,
  type LogLevel,
  type LogTag,
  type Logger,
} from '../util/logger.js';

export interface LogLine {
  level: LogLevel;
  tag: LogTag;
  message: string;
  meta: string;
  at: string;
}

/**
 * A Logger that tees to the terminal and to whoever is watching in a browser.
 *
 * Three things here are load-bearing:
 *
 * 1. redact() is applied to the message AND the serialised meta. The dashboard
 *    now holds live API keys, and an error that echoes a key back would
 *    otherwise be streamed straight to the page.
 * 2. Level filtering is done here. createLogger keeps its own filter inside
 *    itself, so a custom logger receives everything unless it filters.
 * 3. The base logger is always called. Someone watching `pnpm jobs:dashboard`
 *    in a terminal must not lose their log because a browser tab is open.
 */
export function createStreamLogger(options: {
  base: Logger;
  level: LogLevel;
  emit(line: LogLine): void;
}): Logger {
  const { base, level, emit } = options;

  const send = (lvl: LogLevel, tag: LogTag, message: string, meta?: unknown) => {
    base[lvl](tag, message, meta);
    if (!shouldLog(lvl, level)) return;

    emit({
      level: lvl,
      tag,
      message: redact(message),
      meta: meta === undefined ? '' : redact(serialise(meta)),
      at: new Date().toISOString(),
    });
  };

  return {
    debug: (t, m, x) => send('debug', t, m, x),
    info: (t, m, x) => send('info', t, m, x),
    warn: (t, m, x) => send('warn', t, m, x),
    error: (t, m, x) => send('error', t, m, x),
    plain: (m = '') => {
      base.plain(m);
      emit({
        level: 'info',
        tag: 'RUN',
        message: redact(m),
        meta: '',
        at: new Date().toISOString(),
      });
    },
  };
}
