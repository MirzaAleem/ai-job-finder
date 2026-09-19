import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { RawJob } from '../domain/job.schema.js';
import type { BrowserService } from '../browser/browser.service.js';
import { RobotsDisallowedError } from '../browser/robots.js';
import type { Logger } from '../util/logger.js';
import type { FetchJobsOptions, JobSource, SourceStatus } from './source.js';

export const CareerPageConfigSchema = z.object({
  company: z.string().min(1),
  url: z.string().url(),
  /** Selector matching one element per job listing. */
  listSelector: z.string().min(1),
  /** Selectors relative to each listing element. */
  fields: z.object({
    title: z.string().min(1),
    link: z.string().optional(),
    location: z.string().optional(),
    department: z.string().optional(),
    description: z.string().optional(),
  }),
  waitForSelector: z.string().optional(),
  enabled: z.boolean().default(true),

  /**
   * Omit for a single-page board (Lever renders everything at once).
   * Greenhouse and most ATSs page at 50 with `?page=N`.
   */
  pagination: z
    .object({
      /** `query` -> ?page=2 · `path` -> /page/2 */
      type: z.enum(['query', 'path']).default('query'),
      param: z.string().min(1).default('page'),
      startPage: z.number().int().min(0).default(1),
      /** Ceiling, not a target. Paging stops early whenever the board runs out. */
      maxPages: z.number().int().min(1).max(50).default(10),
    })
    .optional(),
});
export type CareerPageConfig = z.infer<typeof CareerPageConfigSchema>;

/** Why a company's page loop ended — surfaced in the log so truncation is never silent. */
type StopReason =
  'single-page' | 'empty-page' | 'partial-page' | 'repeated-page' | 'max-pages' | 'page-error';

export const CareersConfigSchema = z.object({
  companies: z.array(CareerPageConfigSchema).default([]),
});

interface ScrapedListing {
  title: string | null;
  url: string | null;
  location: string | null;
  department: string | null;
  description: string | null;
}

export interface CareersSourceOptions {
  browser: BrowserService;
  logger: Logger;
  configPath: string;
}

/**
 * Generic career-page scraper driven entirely by config/sources.yaml.
 *
 * STATUS: EXPERIMENTAL — it works only as well as the selectors you give it.
 * Nothing here is tuned to any particular ATS; add one entry per company.
 * Every navigation still passes through the robots.txt gate.
 */
export class CareerPagesJobSource implements JobSource {
  readonly name = 'companies';
  readonly status: SourceStatus = 'EXPERIMENTAL';
  readonly notes =
    'Config-driven CSS selectors in config/sources.yaml. Verify each company entry yourself.';

  constructor(private readonly options: CareersSourceOptions) {}

  async fetchJobs(options: FetchJobsOptions = {}): Promise<RawJob[]> {
    const configs = await this.loadConfig();
    if (configs.length === 0) {
      this.options.logger.warn('FETCH', 'companies: no career pages configured, skipping', {
        configPath: this.options.configPath,
        hint: 'copy config/sources.example.yaml to config/sources.yaml',
      });
      return [];
    }

    const jobs: RawJob[] = [];
    for (const config of configs) {
      if (!config.enabled) continue;
      const collected = await this.fetchCompany(config);
      jobs.push(...collected);
      if (options.limit && jobs.length >= options.limit) break;
    }

    return options.limit ? jobs.slice(0, options.limit) : jobs;
  }

  /**
   * Scrape one company, following pagination when configured.
   *
   * Paging is bounded by four independent stop conditions because a loop that
   * cannot distinguish "no more jobs" from "this site ignored your page
   * parameter" will happily fetch page 1 ten times and call it 500 jobs.
   */
  private async fetchCompany(config: CareerPageConfig): Promise<RawJob[]> {
    const maxPages = config.pagination?.maxPages ?? 1;
    const startPage = config.pagination?.startPage ?? 1;

    const jobs: RawJob[] = [];
    const seenUrls = new Set<string>();
    let previousSignature: string | null = null;
    let previousCount: number | null = null;
    let pagesFetched = 0;
    let stopReason: StopReason = config.pagination ? 'max-pages' : 'single-page';

    for (let offset = 0; offset < maxPages; offset += 1) {
      const pageNumber = startPage + offset;
      const url = this.pageUrl(config, pageNumber);

      let listings: ScrapedListing[];
      try {
        listings = await this.options.browser.extractJobs<ScrapedListing>({
          url,
          ...(config.waitForSelector ? { waitForSelector: config.waitForSelector } : {}),
          extract: buildExtractor(config),
        });
      } catch (err) {
        if (err instanceof RobotsDisallowedError) {
          this.options.logger.error('FETCH', 'career page disallowed by robots.txt — skipping', {
            company: config.company,
            url,
          });
          return jobs;
        }
        this.options.logger.error('FETCH', 'career page failed', {
          company: config.company,
          url,
          error: err instanceof Error ? err.message : String(err),
        });
        stopReason = 'page-error';
        break;
      }

      pagesFetched += 1;

      // 1. Nothing here — we have run past the end of the board.
      if (listings.length === 0) {
        if (pagesFetched === 1) {
          this.options.logger.warn('FETCH', 'no listings matched — check listSelector', {
            company: config.company,
            listSelector: config.listSelector,
          });
        }
        stopReason = 'empty-page';
        break;
      }

      // 2. Identical to the previous page: the site ignored the page parameter
      //    and re-served the same listings. Without this guard a misconfigured
      //    entry silently multiplies duplicates up to maxPages.
      const signature = listings.map((l) => l.url ?? l.title ?? '').join('|');
      if (previousSignature !== null && signature === previousSignature) {
        this.options.logger.warn('FETCH', 'page repeated — site ignores the page parameter', {
          company: config.company,
          url,
          hint: 'check the pagination.param value, or remove the pagination block',
        });
        stopReason = 'repeated-page';
        break;
      }
      previousSignature = signature;

      for (const listing of listings) {
        if (!listing.title) continue;
        const absoluteUrl = this.absolute(listing.url, url);
        // Belt and braces: a board that overlaps pages must not yield duplicates.
        if (seenUrls.has(absoluteUrl)) continue;
        seenUrls.add(absoluteUrl);

        jobs.push({
          source: this.name,
          externalId: null,
          company: config.company,
          title: listing.title,
          description: listing.description ?? listing.department ?? '',
          location: listing.location,
          remote: null,
          salary: null,
          experience: null,
          skills: [],
          url: absoluteUrl,
          applicationUrl: null,
          postedAt: null,
          rawData: { department: listing.department, page: pageNumber },
        });
      }

      if (!config.pagination) {
        stopReason = 'single-page';
        break;
      }

      // 3. A short page is the last page. Its jobs are already collected.
      if (previousCount !== null && listings.length < previousCount) {
        stopReason = 'partial-page';
        break;
      }
      previousCount = listings.length;
    }

    if (stopReason === 'max-pages') {
      this.options.logger.warn('FETCH', 'hit the page limit — the board may have more', {
        company: config.company,
        maxPages,
        hint: 'raise pagination.maxPages for this company in config/sources.yaml',
      });
    }

    this.options.logger.info('FETCH', 'career page scraped', {
      company: config.company,
      found: jobs.length,
      pages: pagesFetched,
      stoppedBecause: stopReason,
    });

    return jobs;
  }

  /** Build the URL for page N, leaving page `startPage` as the configured URL. */
  private pageUrl(config: CareerPageConfig, pageNumber: number): string {
    const pagination = config.pagination;
    if (!pagination || pageNumber === pagination.startPage) return config.url;

    if (pagination.type === 'path') {
      const base = config.url.replace(/\/+$/, '');
      return `${base}/${pagination.param}/${pageNumber}`;
    }

    const url = new URL(config.url);
    url.searchParams.set(pagination.param, String(pageNumber));
    return url.toString();
  }

  private absolute(href: string | null, pageUrl: string): string {
    if (!href) return pageUrl;
    try {
      return new URL(href, pageUrl).toString();
    } catch {
      return pageUrl;
    }
  }

  private async loadConfig(): Promise<CareerPageConfig[]> {
    const abs = path.resolve(this.options.configPath);
    if (!existsSync(abs)) return [];
    const parsed = CareersConfigSchema.safeParse(parseYaml(await readFile(abs, 'utf8')));
    if (!parsed.success) {
      this.options.logger.error('FETCH', 'sources.yaml is invalid', {
        issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      });
      return [];
    }
    return parsed.data.companies;
  }
}

/**
 * Builds the in-page function. The config is serialised into the closure via
 * page.evaluate's argument boundary, so it is stringified by Playwright — hence
 * the selectors are inlined rather than referenced.
 */
function buildExtractor(config: CareerPageConfig): () => ScrapedListing[] {
  const { listSelector, fields } = config;
  const serialised = JSON.stringify({ listSelector, fields });

  return new Function(
    `const cfg = ${serialised};
     const text = (el) => { const v = el && el.textContent ? el.textContent.trim() : ''; return v || null; };
     const nodes = document.querySelectorAll(cfg.listSelector);
     const out = [];
     nodes.forEach((node) => {
       const linkEl = cfg.fields.link ? node.querySelector(cfg.fields.link) : node.querySelector('a');
       out.push({
         title: text(node.querySelector(cfg.fields.title)),
         url: linkEl ? linkEl.getAttribute('href') : null,
         location: cfg.fields.location ? text(node.querySelector(cfg.fields.location)) : null,
         department: cfg.fields.department ? text(node.querySelector(cfg.fields.department)) : null,
         description: cfg.fields.description ? text(node.querySelector(cfg.fields.description)) : null,
       });
     });
     return out;`,
  ) as () => ScrapedListing[];
}
