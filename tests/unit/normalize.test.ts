import { describe, expect, it } from 'vitest';
import {
  NormalizationError,
  normalizeJob,
  parseExperience,
  parsePostedAt,
  parseRemote,
  parseSalary,
} from '../../src/pipeline/normalize.js';
import { htmlToText, truncate } from '../../src/util/text.js';
import { rawJob } from '../helpers/fixtures.js';

const NOW = new Date('2026-09-12T00:00:00Z');

describe('salary parsing', () => {
  it('reads an Indian LPA range into absolute annual figures', () => {
    const salary = parseSalary('₹35-50 LPA');
    expect(salary?.currency).toBe('INR');
    expect(salary?.min).toBe(3_500_000);
    expect(salary?.max).toBe(5_000_000);
    expect(salary?.period).toBe('YEARLY');
  });

  it('reads a USD range', () => {
    const salary = parseSalary('$70,000 - $95,000');
    expect(salary?.currency).toBe('USD');
    expect(salary?.min).toBe(70_000);
    expect(salary?.max).toBe(95_000);
  });

  it('treats "Not disclosed" as unknown, not as zero', () => {
    const salary = parseSalary('Not disclosed');
    expect(salary?.min).toBeNull();
    expect(salary?.max).toBeNull();
    expect(salary?.raw).toBe('Not disclosed');
  });

  it('returns null when nothing was stated at all', () => {
    expect(parseSalary(null)).toBeNull();
    expect(parseSalary('')).toBeNull();
  });

  it('always keeps the original text', () => {
    expect(parseSalary('12 LPA fixed + variable')?.raw).toBe('12 LPA fixed + variable');
  });
});

describe('experience parsing', () => {
  it('reads a range', () => {
    expect(parseExperience('5-9 years')).toMatchObject({ minYears: 5, maxYears: 9 });
  });

  it('reads an open-ended minimum', () => {
    expect(parseExperience('8+ years')).toMatchObject({ minYears: 8, maxYears: null });
  });

  it('reads "minimum N years"', () => {
    expect(parseExperience('minimum 4 years of backend work')).toMatchObject({ minYears: 4 });
  });

  it('treats fresher as zero years, not as unknown', () => {
    expect(parseExperience('Fresher')).toMatchObject({ minYears: 0 });
  });

  it('returns null when unstated', () => {
    expect(parseExperience(null)).toBeNull();
  });

  it('keeps unreadable text rather than guessing a number', () => {
    const parsed = parseExperience('as per company norms');
    expect(parsed?.minYears).toBeNull();
    expect(parsed?.raw).toBe('as per company norms');
  });
});

describe('remote parsing', () => {
  it('detects explicit remote phrasing', () => {
    expect(parseRemote('Fully remote')).toBe('REMOTE');
    expect(parseRemote('Work from home')).toBe('REMOTE');
  });

  it('detects hybrid and onsite', () => {
    expect(parseRemote('Hybrid')).toBe('HYBRID');
    expect(parseRemote('On-site')).toBe('ONSITE');
  });

  it('returns null when the posting says nothing about it', () => {
    expect(parseRemote(null, 'Pune, India')).toBeNull();
  });

  it('prefers hybrid over a bare mention of remote', () => {
    expect(parseRemote('Hybrid - 2 days remote')).toBe('HYBRID');
  });
});

describe('posted date parsing', () => {
  it('reads relative dates', () => {
    expect(parsePostedAt('today', NOW)?.toISOString()).toBe(NOW.toISOString());
    expect(parsePostedAt('3 days ago', NOW)?.toISOString()).toBe('2026-09-09T00:00:00.000Z');
    expect(parsePostedAt('2 weeks ago', NOW)?.toISOString()).toBe('2026-08-29T00:00:00.000Z');
  });

  it('reads absolute dates', () => {
    expect(parsePostedAt('2026-09-01', NOW)?.toISOString().slice(0, 10)).toBe('2026-09-01');
  });

  it('returns null for unparseable text', () => {
    expect(parsePostedAt('recently', NOW)).toBeNull();
  });
});

describe('html handling', () => {
  it('strips tags and keeps readable structure', () => {
    const text = htmlToText('<p>Hello</p><ul><li>One</li><li>Two</li></ul>');
    expect(text).not.toContain('<');
    expect(text).toContain('Hello');
    expect(text).toContain('One');
  });

  it('drops script and style content entirely', () => {
    expect(htmlToText('<script>evil()</script><p>Safe</p>')).not.toContain('evil');
  });

  it('marks truncation so the model knows the text is partial', () => {
    const result = truncate('word '.repeat(500), 100);
    expect(result.length).toBeLessThan(200);
    expect(result).toContain('truncated');
  });
});

describe('job normalization', () => {
  it('produces a valid normalized job', () => {
    const normalized = normalizeJob(rawJob(), { now: NOW });
    expect(normalized.title).toBe('Senior Backend Engineer');
    expect(normalized.remote).toBe('HYBRID');
    expect(normalized.salary?.min).toBe(3_000_000);
    expect(normalized.fingerprint).toHaveLength(64);
    expect(normalized.contentHash).toHaveLength(64);
    expect(normalized.firstSeenAt).toEqual(NOW);
  });

  it('rejects a job with no title, company, or URL', () => {
    expect(() => normalizeJob(rawJob({ title: null }))).toThrow(NormalizationError);
    expect(() => normalizeJob(rawJob({ company: null }))).toThrow(NormalizationError);
    expect(() => normalizeJob(rawJob({ url: null }))).toThrow(NormalizationError);
  });

  it('keeps missing optional fields as null rather than inventing values', () => {
    const normalized = normalizeJob(
      rawJob({ salary: null, experience: null, location: null, remote: null, description: '' }),
      { now: NOW },
    );
    expect(normalized.salary).toBeNull();
    expect(normalized.experienceRequired).toBeNull();
    expect(normalized.location).toBeNull();
    expect(normalized.remote).toBeNull();
  });

  it('derives a stable external id when the source provides none', () => {
    const a = normalizeJob(rawJob({ externalId: null }), { now: NOW });
    const b = normalizeJob(rawJob({ externalId: null }), { now: NOW });
    expect(a.externalId).toBe(b.externalId);
    expect(a.externalId.length).toBeGreaterThan(0);
  });

  it('converts HTML descriptions to plain text', () => {
    const normalized = normalizeJob(rawJob({ description: '<p>Build <b>services</b></p>' }), {
      now: NOW,
    });
    expect(normalized.description).not.toContain('<');
    expect(normalized.description).toContain('services');
  });

  it('infers remote status from the description when the field is absent', () => {
    const normalized = normalizeJob(
      rawJob({ remote: null, location: null, description: 'This role is fully remote.' }),
      { now: NOW },
    );
    expect(normalized.remote).toBe('REMOTE');
  });
});
