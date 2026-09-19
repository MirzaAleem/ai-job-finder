import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import type { Logger } from '../util/logger.js';
import { RobotsGate } from './robots.js';

/**
 * Identifies the tool honestly. This is a personal, human-paced browser agent;
 * it does not impersonate a search-engine crawler or hide what it is.
 */
export const USER_AGENT_SUFFIX = 'AIJobFinder/1.0 (+personal job search; respects robots.txt)';

export interface BrowserServiceOptions {
  headless: boolean;
  timeoutMs: number;
  /** Politeness delay between navigations. */
  delayMs: number;
  respectRobots: boolean;
  logger: Logger;
}

export interface ExtractOptions<T> {
  url: string;
  /** Runs in the page; must be self-contained (no closures over Node scope). */
  extract: () => T[];
  waitForSelector?: string;
}

/**
 * Owns everything Playwright. No business logic lives here, and no source
 * adapter talks to Playwright directly — so browser concerns stay swappable.
 *
 * Never stores cookies, credentials, or session state to disk.
 */
export class BrowserService {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private lastNavigationAt = 0;
  readonly robots: RobotsGate;

  constructor(private readonly options: BrowserServiceOptions) {
    this.robots = new RobotsGate(USER_AGENT_SUFFIX, options.logger, options.respectRobots);
  }

  async launchBrowser(): Promise<Browser> {
    if (this.browser) return this.browser;
    this.options.logger.info('BROWSER', 'launching', { headless: this.options.headless });
    this.browser = await chromium.launch({ headless: this.options.headless });
    return this.browser;
  }

  async createContext(): Promise<BrowserContext> {
    if (this.context) return this.context;
    const browser = await this.launchBrowser();
    this.context = await browser.newContext({
      // A real Chromium UA with our identifier appended — accurate, not a disguise.
      userAgent: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 ${USER_AGENT_SUFFIX}`,
      viewport: { width: 1440, height: 900 },
      locale: 'en-IN',
      // Explicitly ephemeral: nothing is persisted between runs.
      storageState: undefined,
    });
    this.context.setDefaultTimeout(this.options.timeoutMs);
    return this.context;
  }

  /** Opens a page only after robots.txt has permitted the exact URL. */
  async openPage(url: string): Promise<Page> {
    await this.robots.assertAllowed(url);
    await this.throttle();

    const context = await this.createContext();
    const page = await context.newPage();
    this.options.logger.debug('BROWSER', 'navigating', { url });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.options.timeoutMs });
    this.lastNavigationAt = Date.now();
    return page;
  }

  /** Navigate, wait for content, run an in-page extractor, close the page. */
  async extractJobs<T>(options: ExtractOptions<T>): Promise<T[]> {
    const page = await this.openPage(options.url);
    try {
      if (options.waitForSelector) {
        await page
          .waitForSelector(options.waitForSelector, { timeout: this.options.timeoutMs })
          .catch(() => {
            this.options.logger.warn('BROWSER', 'expected selector never appeared', {
              url: options.url,
              selector: options.waitForSelector,
            });
          });
      }
      return await page.evaluate(options.extract);
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  /** Honour our own politeness delay between navigations. */
  private async throttle(): Promise<void> {
    const elapsed = Date.now() - this.lastNavigationAt;
    const wait = this.options.delayMs - elapsed;
    if (this.lastNavigationAt > 0 && wait > 0) {
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }

  async close(): Promise<void> {
    await this.context?.close().catch(() => undefined);
    await this.browser?.close().catch(() => undefined);
    this.context = null;
    this.browser = null;
    this.options.logger.debug('BROWSER', 'closed');
  }
}
