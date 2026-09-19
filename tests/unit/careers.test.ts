import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CareerPagesJobSource } from '../../src/sources/careers.source.js';
import type { BrowserService } from '../../src/browser/browser.service.js';
import { RobotsDisallowedError } from '../../src/browser/robots.js';
import { createSilentLogger } from '../../src/util/logger.js';

interface Listing {
  title: string | null;
  url: string | null;
  location: string | null;
  department: string | null;
  description: string | null;
}

const listing = (id: string): Listing => ({
  title: `Engineer ${id}`,
  url: `https://board.test/jobs/${id}`,
  location: 'Remote',
  department: null,
  description: null,
});

/** N listings whose ids are unique to the given page. */
const page = (pageNumber: number, count: number): Listing[] =>
  Array.from({ length: count }, (_, i) => listing(`p${pageNumber}-${i}`));

/**
 * Stands in for BrowserService. Records every URL requested so pagination can
 * be asserted on the exact sequence of navigations, with no network involved.
 */
function fakeBrowser(pages: Listing[][] | ((url: string) => Listing[])) {
  const requested: string[] = [];
  const service = {
    requested,
    async extractJobs<T>({ url }: { url: string }): Promise<T[]> {
      requested.push(url);
      if (typeof pages === 'function') return pages(url) as T[];
      const index = requested.length - 1;
      return (pages[index] ?? []) as T[];
    },
    async close() {},
  };
  return service as unknown as BrowserService & { requested: string[] };
}

let dir: string | null = null;

async function configFile(yaml: string): Promise<string> {
  dir = await mkdtemp(path.join(tmpdir(), 'careers-'));
  const filePath = path.join(dir, 'sources.yaml');
  await writeFile(filePath, yaml, 'utf8');
  return filePath;
}

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = null;
});

const PAGINATED = `
companies:
  - company: Board
    url: https://board.test/jobs
    listSelector: "tr.job"
    fields:
      title: "a"
      link: "a"
    pagination:
      type: query
      param: page
      startPage: 1
      maxPages: 10
`;

const SINGLE_PAGE = `
companies:
  - company: Board
    url: https://board.test/jobs
    listSelector: "tr.job"
    fields:
      title: "a"
      link: "a"
`;

async function run(yaml: string, browser: ReturnType<typeof fakeBrowser>) {
  const configPath = await configFile(yaml);
  const source = new CareerPagesJobSource({
    browser,
    logger: createSilentLogger(),
    configPath,
  });
  return source.fetchJobs({});
}

describe('career page pagination', () => {
  it('follows pages until a partial page ends the board', async () => {
    // 50, 50, 27 — exactly the shape Greenhouse returns for a 127-job board.
    const browser = fakeBrowser([page(1, 50), page(2, 50), page(3, 27)]);
    const jobs = await run(PAGINATED, browser);

    expect(jobs).toHaveLength(127);
    expect(browser.requested).toEqual([
      'https://board.test/jobs',
      'https://board.test/jobs?page=2',
      'https://board.test/jobs?page=3',
    ]);
  });

  it('stops on an empty page', async () => {
    const browser = fakeBrowser([page(1, 50), page(2, 50), []]);
    const jobs = await run(PAGINATED, browser);

    expect(jobs).toHaveLength(100);
    expect(browser.requested).toHaveLength(3);
  });

  it('stops when the site ignores the page parameter and repeats itself', async () => {
    // The dangerous case: every page returns identical listings.
    const identical = page(1, 50);
    const browser = fakeBrowser(() => identical);
    const jobs = await run(PAGINATED, browser);

    // One page collected, then the guard fires — not 500 duplicates.
    expect(jobs).toHaveLength(50);
    expect(browser.requested).toHaveLength(2);
  });

  it('never emits duplicate URLs even when pages overlap', async () => {
    const overlapping = [
      [...page(1, 30), listing('shared')],
      [listing('shared'), ...page(2, 30)],
      page(3, 5),
    ];
    const jobs = await run(PAGINATED, fakeBrowser(overlapping));

    const urls = jobs.map((j) => j.url);
    expect(new Set(urls).size).toBe(urls.length);
  });

  it('honours the maxPages ceiling', async () => {
    const yaml = PAGINATED.replace('maxPages: 10', 'maxPages: 3');
    const browser = fakeBrowser(Array.from({ length: 10 }, (_, i) => page(i + 1, 50)));
    const jobs = await run(yaml, browser);

    expect(browser.requested).toHaveLength(3);
    expect(jobs).toHaveLength(150);
  });

  it('builds path-style pagination URLs', async () => {
    const yaml = PAGINATED.replace('type: query', 'type: path').replace('param: page', 'param: p');
    const browser = fakeBrowser([page(1, 10), page(2, 5)]);
    await run(yaml, browser);

    expect(browser.requested).toEqual(['https://board.test/jobs', 'https://board.test/jobs/p/2']);
  });

  it('preserves existing query parameters when adding the page parameter', async () => {
    const yaml = PAGINATED.replace(
      'url: https://board.test/jobs',
      'url: https://board.test/jobs?team=eng',
    );
    const browser = fakeBrowser([page(1, 10), page(2, 5)]);
    await run(yaml, browser);

    expect(browser.requested[1]).toContain('team=eng');
    expect(browser.requested[1]).toContain('page=2');
  });

  it('supports boards that start at page 0', async () => {
    const yaml = PAGINATED.replace('startPage: 1', 'startPage: 0');
    const browser = fakeBrowser([page(1, 10), page(2, 5)]);
    await run(yaml, browser);

    expect(browser.requested).toEqual([
      'https://board.test/jobs',
      'https://board.test/jobs?page=1',
    ]);
  });
});

describe('career pages without pagination', () => {
  it('fetches exactly one page when no pagination block is configured', async () => {
    const browser = fakeBrowser([page(1, 50), page(2, 50)]);
    const jobs = await run(SINGLE_PAGE, browser);

    // Lever behaviour: one request, regardless of how full the page is.
    expect(browser.requested).toEqual(['https://board.test/jobs']);
    expect(jobs).toHaveLength(50);
  });

  it('warns and returns nothing when the selector matches nothing', async () => {
    const jobs = await run(SINGLE_PAGE, fakeBrowser([[]]));
    expect(jobs).toEqual([]);
  });
});

describe('career page error handling', () => {
  it('skips a company whose robots.txt disallows it', async () => {
    const browser = {
      async extractJobs(): Promise<never[]> {
        throw new RobotsDisallowedError('https://board.test/jobs', '*');
      },
      async close() {},
    } as unknown as BrowserService;

    await expect(run(PAGINATED, browser as never)).resolves.toEqual([]);
  });

  it('keeps the pages it already collected when a later page fails', async () => {
    let call = 0;
    const browser = fakeBrowser(() => {
      call += 1;
      if (call === 3) throw new Error('navigation timeout');
      return page(call, 50);
    });

    const jobs = await run(PAGINATED, browser);
    expect(jobs).toHaveLength(100);
  });

  it('returns nothing when the config file is absent', async () => {
    const source = new CareerPagesJobSource({
      browser: fakeBrowser([]),
      logger: createSilentLogger(),
      configPath: '/nope/sources.yaml',
    });
    expect(await source.fetchJobs({})).toEqual([]);
  });
});
