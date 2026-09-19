import { describe, it, expect } from 'vitest';
import { createStreamLogger, type LogLine } from '../../src/dashboard/stream-logger.js';
import { createSilentLogger } from '../../src/util/logger.js';

function harness(level: 'debug' | 'info' | 'warn' | 'error' = 'debug') {
  const base = createSilentLogger();
  const lines: LogLine[] = [];
  const logger = createStreamLogger({ base, level, emit: (line) => lines.push(line) });
  return { base, lines, logger };
}

describe('createStreamLogger', () => {
  it('emits a structured line', () => {
    const { lines, logger } = harness();
    logger.info('FETCH', 'mock: 25 jobs', { source: 'mock' });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: 'info', tag: 'FETCH', message: 'mock: 25 jobs' });
    expect(lines[0]?.meta).toContain('mock');
    expect(Date.parse(lines[0]?.at ?? '')).not.toBeNaN();
  });

  it('still writes to the terminal logger', () => {
    const { base, logger } = harness();
    logger.warn('DB', 'slow query');
    expect(base.lines.join('\n')).toContain('slow query');
  });

  it('redacts a key in the message', () => {
    const { lines, logger } = harness();
    logger.error('CLOUD-LLM', 'rejected key sk-or-v1-abcdef1234567890');

    expect(lines[0]?.message).not.toContain('sk-or-v1-abcdef1234567890');
    expect(lines[0]?.message).toContain('[REDACTED]');
  });

  it('redacts a key hidden in the meta object', () => {
    const { lines, logger } = harness();
    logger.error('CLOUD-LLM', 'request failed', {
      apiKey: 'sk-or-v1-abcdef1234567890',
      url: 'https://openrouter.ai/api/v1',
    });

    const serialised = JSON.stringify(lines[0]);
    expect(serialised).not.toContain('sk-or-v1-abcdef1234567890');
    expect(lines[0]?.meta).toContain('[REDACTED]');
  });

  it('redacts credentials embedded in a URL', () => {
    const { lines, logger } = harness();
    logger.info('BROWSER', 'navigating', { url: 'https://user:hunter2@proxy.internal/page' });
    expect(lines[0]?.meta).not.toContain('hunter2');
  });

  it('does its own level filtering, which createLogger keeps to itself', () => {
    const { lines, logger } = harness('warn');
    logger.debug('CACHE', 'hit');
    logger.info('FETCH', 'fetched');
    logger.warn('DB', 'slow');
    logger.error('ERROR', 'broken');

    expect(lines.map((l) => l.level)).toEqual(['warn', 'error']);
  });

  it('passes filtered-out lines to the terminal anyway', () => {
    const { base, logger } = harness('error');
    logger.info('FETCH', 'quiet detail');
    expect(base.lines.join('\n')).toContain('quiet detail');
  });

  it('forwards plain summary lines', () => {
    const { lines, logger } = harness();
    logger.plain('Results:');
    expect(lines[0]).toMatchObject({ message: 'Results:', tag: 'RUN' });
  });

  it('handles an Error passed as meta', () => {
    const { lines, logger } = harness();
    logger.error('ERROR', 'run failed', new Error('boom'));
    expect(lines[0]?.meta).toContain('boom');
  });
});
