import type { Env } from '../config/env.js';
import { enabledSources } from '../config/env.js';
import type { Logger } from '../util/logger.js';
import { BrowserService } from '../browser/browser.service.js';
import type { JobSource } from './source.js';
import { MockJobSource } from './mock.source.js';
import { ImportJobSource } from './import.source.js';
import { CareerPagesJobSource } from './careers.source.js';

export interface SourceBundle {
  sources: JobSource[];
  /** Present only when a browser-backed source was requested. */
  browser: BrowserService | null;
}

/**
 * Builds only the sources that are actually enabled, and only creates a browser
 * when one is genuinely needed — a mock-only run must never launch Chromium.
 */
export function buildSources(env: Env, logger: Logger): SourceBundle {
  const requested = enabledSources(env);
  const needsBrowser = requested.includes('companies');

  const browser = needsBrowser
    ? new BrowserService({
        headless: env.PLAYWRIGHT_HEADLESS,
        timeoutMs: env.BROWSER_TIMEOUT_MS,
        delayMs: env.SCRAPE_DELAY_MS,
        respectRobots: env.RESPECT_ROBOTS_TXT,
        logger,
      })
    : null;

  const sources: JobSource[] = [];

  for (const name of requested) {
    switch (name) {
      case 'mock':
        sources.push(new MockJobSource());
        break;

      case 'import':
        if (!env.IMPORT_FILE) {
          logger.warn('FETCH', 'import source enabled but IMPORT_FILE is not set — skipping');
          break;
        }
        sources.push(new ImportJobSource({ filePath: env.IMPORT_FILE, logger }));
        break;

      case 'companies':
        if (!browser) break;
        sources.push(
          new CareerPagesJobSource({ browser, logger, configPath: env.SOURCES_CONFIG_PATH }),
        );
        break;

      default:
        logger.warn('FETCH', 'unknown source in SOURCES_ENABLED — ignoring', { name });
    }
  }

  return { sources, browser };
}

export function sourceQueries(env: Env): string[] {
  return env.SEARCH_QUERIES.split(',')
    .map((q) => q.trim())
    .filter(Boolean);
}
