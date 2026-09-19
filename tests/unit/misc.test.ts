import { describe, expect, it } from 'vitest';
import { createSilentLogger, redact } from '../../src/util/logger.js';
import { UsageTracker } from '../../src/llm/cost.js';
import { recommendationForScore } from '../../src/config/scoring.js';
import { buildPolicy, parseRobotsTxt } from '../../src/browser/robots.js';
import { MockJobSource } from '../../src/sources/mock.source.js';
import { MOCK_JOB_COUNT } from '../../src/sources/mock-data.js';

describe('secret redaction', () => {
  it.each([
    ['sk-or-v1-abcdefghijklmnopqrstuvwxyz123456'],
    ['AIzaSyA1234567890abcdefghijklmnopqrstu'],
    ['AQ.Ab8RN6IabcdefghijklmnopqrstuvwxyZ12'],
    ['ghp_abcdefghijklmnopqrstuvwxyz1234567890'],
  ])('scrubs %s', (secret) => {
    expect(redact(`key is ${secret}`)).not.toContain(secret);
    expect(redact(`key is ${secret}`)).toContain('[REDACTED]');
  });

  it.each([
    ['https://alice:hunter2@proxy.internal:8080/v1'],
    ['http://ollama:s3cr3t@10.0.0.4:11434'],
  ])('scrubs credentials embedded in a URL: %s', (uri) => {
    const scrubbed = redact(uri);
    expect(scrubbed).not.toContain('hunter2');
    expect(scrubbed).not.toContain('s3cr3t');
    expect(scrubbed).toContain('[REDACTED]');
  });

  it('leaves a URL without credentials alone', () => {
    const uri = 'http://localhost:11434/api/tags';
    expect(redact(uri)).toBe(uri);
  });

  it('scrubs bearer tokens', () => {
    expect(redact('Authorization: Bearer abcdef1234567890')).toContain('[REDACTED]');
  });

  it('leaves ordinary text untouched', () => {
    expect(redact('Evaluated 52 jobs, 0 escalations')).toBe('Evaluated 52 jobs, 0 escalations');
  });

  it('redacts through the logger', () => {
    const logger = createSilentLogger();
    logger.info('CLOUD-LLM', 'calling', { key: 'sk-or-v1-abcdefghijklmnopqrstuvwxyz123456' });
    expect(logger.lines.join('')).not.toContain('sk-or-v1');
  });
});

describe('cost tracking', () => {
  it('reports zero cost for a local-only run', () => {
    const usage = new UsageTracker({ inputCostPerMTok: 0.1, outputCostPerMTok: 0.4 });
    usage.record('local', { inputTokens: 50_000, outputTokens: 10_000 });
    expect(usage.estimatedCloudCost()).toBe(0);
    expect(usage.summary().cloudRequests).toBe(0);
    expect(usage.summary().localRequests).toBe(1);
  });

  it('prices cloud tokens at the configured rates', () => {
    const usage = new UsageTracker({ inputCostPerMTok: 1, outputCostPerMTok: 2 });
    usage.record('cloud', { inputTokens: 1_000_000, outputTokens: 500_000 });
    expect(usage.estimatedCloudCost()).toBe(2);
  });

  it('accumulates across requests', () => {
    const usage = new UsageTracker({ inputCostPerMTok: 1, outputCostPerMTok: 1 });
    usage.record('cloud', { inputTokens: 100, outputTokens: 100 });
    usage.record('cloud', { inputTokens: 100, outputTokens: 100 });
    expect(usage.summary().cloudRequests).toBe(2);
    expect(usage.summary().cloudInputTokens).toBe(200);
  });
});

describe('score thresholds', () => {
  const t = { highPriority: 90, apply: 80, consider: 65 };

  it.each([
    [100, 'HIGH_PRIORITY'],
    [90, 'HIGH_PRIORITY'],
    [89, 'APPLY'],
    [80, 'APPLY'],
    [79, 'CONSIDER'],
    [65, 'CONSIDER'],
    [64, 'SKIP'],
    [0, 'SKIP'],
  ])('maps %i to %s', (score, expected) => {
    expect(recommendationForScore(score, t)).toBe(expected);
  });

  it('honours custom thresholds', () => {
    expect(recommendationForScore(75, { highPriority: 70, apply: 60, consider: 50 })).toBe(
      'HIGH_PRIORITY',
    );
  });
});

describe('robots.txt parsing', () => {
  const NAUKRI_SHAPED = `
User-agent: claudebot
User-agent: gptbot
Disallow: /
Allow: /blog/

User-agent: *
Disallow: /advertiser/
Disallow: /photo/

Sitemap: https://example.com/sitemap.xml
`;

  it('applies the wildcard group to an agent not named anywhere', () => {
    const policy = buildPolicy(parseRobotsTxt(NAUKRI_SHAPED), 'AIJobFinder/1.0');
    expect(policy.matchedAgent).toBe('*');
    expect(policy.isAllowed('/software-engineer-jobs')).toBe(true);
    expect(policy.isAllowed('/advertiser/x')).toBe(false);
  });

  it('applies the restrictive group to an agent that is named', () => {
    const policy = buildPolicy(parseRobotsTxt(NAUKRI_SHAPED), 'claudebot');
    expect(policy.matchedAgent).toBe('claudebot');
    expect(policy.isAllowed('/software-engineer-jobs')).toBe(false);
  });

  it('honours Allow overriding a broader Disallow', () => {
    const policy = buildPolicy(parseRobotsTxt(NAUKRI_SHAPED), 'gptbot');
    expect(policy.isAllowed('/blog/post')).toBe(true);
    expect(policy.isAllowed('/jobs')).toBe(false);
  });

  it('treats an empty Disallow as permitting everything', () => {
    const policy = buildPolicy(parseRobotsTxt('User-agent: *\nDisallow:'), 'anything');
    expect(policy.isAllowed('/anything')).toBe(true);
  });

  it('supports wildcard and end-anchor patterns', () => {
    const policy = buildPolicy(
      parseRobotsTxt('User-agent: *\nDisallow: /search/*/private\nDisallow: /tmp$'),
      'x',
    );
    expect(policy.isAllowed('/search/abc/private')).toBe(false);
    expect(policy.isAllowed('/search/abc/public')).toBe(true);
    expect(policy.isAllowed('/tmp')).toBe(false);
  });

  it('ignores comments and blank lines', () => {
    const policy = buildPolicy(
      parseRobotsTxt('# a comment\n\nUser-agent: *\nDisallow: /x # trailing'),
      'y',
    );
    expect(policy.isAllowed('/x')).toBe(false);
  });

  it('reads crawl-delay', () => {
    const policy = buildPolicy(parseRobotsTxt('User-agent: *\nCrawl-delay: 10'), 'y');
    expect(policy.crawlDelaySeconds).toBe(10);
  });
});

describe('mock source', () => {
  it('returns the full fixture set', async () => {
    const jobs = await new MockJobSource().fetchJobs({});
    expect(jobs).toHaveLength(MOCK_JOB_COUNT);
    expect(jobs.every((j) => j.title && j.company && j.url)).toBe(true);
  });

  it('filters by query', async () => {
    const jobs = await new MockJobSource().fetchJobs({ queries: ['kubernetes'] });
    expect(jobs.length).toBeGreaterThan(0);
    expect(jobs.length).toBeLessThan(MOCK_JOB_COUNT);
  });

  it('respects a limit', async () => {
    expect(await new MockJobSource().fetchJobs({ limit: 3 })).toHaveLength(3);
  });
});
