import {
  NormalizedJobSchema,
  type ExperienceRange,
  type NormalizedJob,
  type RawJob,
  type RemoteStatus,
  type SalaryRange,
} from '../domain/job.schema.js';
import { htmlToText, normalizeUrl } from '../util/text.js';
import { sha256 } from '../util/hash.js';
import { computeContentHash, computeFingerprint } from './fingerprint.js';

export class NormalizationError extends Error {
  constructor(
    message: string,
    readonly raw: RawJob,
  ) {
    super(message);
    this.name = 'NormalizationError';
  }
}

const REMOTE_PATTERNS: Array<[RegExp, RemoteStatus]> = [
  [/\b(fully remote|100% remote|remote only|work from home|wfh|telecommute)\b/i, 'REMOTE'],
  [/\bhybrid\b/i, 'HYBRID'],
  [/\b(on[- ]?site|in[- ]?office|work from office|wfo)\b/i, 'ONSITE'],
  [/\bremote\b/i, 'REMOTE'],
];

/** Returns null when the text simply does not say — never a guess. */
export function parseRemote(...inputs: Array<string | null | undefined>): RemoteStatus {
  const text = inputs.filter(Boolean).join(' ');
  if (!text.trim()) return null;
  for (const [pattern, status] of REMOTE_PATTERNS) {
    if (pattern.test(text)) return status;
  }
  return null;
}

const LAKH = 100_000;
const CRORE = 10_000_000;

/**
 * Indian boards quote "12-18 LPA", US boards "$120,000 - $150,000".
 * Anything we cannot confidently read is kept as raw text so the model can see
 * the original rather than a wrong number.
 */
export function parseSalary(input: string | null | undefined): SalaryRange {
  if (!input) return null;
  const text = input.trim();
  if (!text) return null;

  const lower = text.toLowerCase();
  if (
    /not disclosed|not specified|unspecified|as per (industry|company)|negotiable|confidential/i.test(
      lower,
    )
  ) {
    return { currency: null, min: null, max: null, period: null, raw: text };
  }

  const currency = /(?:₹|rs\.?|inr|lpa|lakh|crore)/i.test(lower)
    ? 'INR'
    : /(?:\$|usd)/i.test(lower)
      ? 'USD'
      : /(?:€|eur)/i.test(lower)
        ? 'EUR'
        : /(?:£|gbp)/i.test(lower)
          ? 'GBP'
          : null;

  const period: 'YEARLY' | 'MONTHLY' | 'HOURLY' | null = /\b(per hour|hourly|\/hr|\/hour)\b/i.test(
    lower,
  )
    ? 'HOURLY'
    : /\b(per month|monthly|\/mo|\/month|pm)\b/i.test(lower)
      ? 'MONTHLY'
      : /\b(lpa|per annum|annually|yearly|per year|\/yr|\/year|pa)\b/i.test(lower)
        ? 'YEARLY'
        : null;

  const isLakh = /\b(lpa|lakh|lac)\b/i.test(lower);
  const isCrore = /\bcrore\b/i.test(lower);

  const numbers = [...lower.matchAll(/(\d+(?:[.,]\d+)*)/g)]
    .map((m) => Number((m[1] ?? '').replace(/,/g, '')))
    .filter((n) => Number.isFinite(n) && n > 0);

  if (numbers.length === 0) {
    return { currency, min: null, max: null, period, raw: text };
  }

  const multiplier = isCrore ? CRORE : isLakh ? LAKH : 1;
  const scaled = numbers.map((n) => n * multiplier);
  const min = Math.min(...scaled);
  const max = Math.max(...scaled);

  return {
    currency,
    min,
    max: max === min ? null : max,
    period: period ?? (isLakh || isCrore ? 'YEARLY' : null),
    raw: text,
  };
}

/** "3-7 years", "5+ yrs", "minimum 4 years". Unreadable input stays raw. */
export function parseExperience(input: string | null | undefined): ExperienceRange {
  if (!input) return null;
  const text = input.trim();
  if (!text) return null;

  const lower = text.toLowerCase();
  if (/fresher|entry.level|no experience|0 years/i.test(lower)) {
    return { minYears: 0, maxYears: null, raw: text };
  }

  const range = lower.match(/(\d+(?:\.\d+)?)\s*(?:-|–|—|to)\s*(\d+(?:\.\d+)?)/);
  if (range) {
    const lo = Number(range[1]);
    const hi = Number(range[2]);
    if (Number.isFinite(lo) && Number.isFinite(hi)) {
      return { minYears: Math.min(lo, hi), maxYears: Math.max(lo, hi), raw: text };
    }
  }

  const plus = lower.match(/(\d+(?:\.\d+)?)\s*\+/);
  if (plus) return { minYears: Number(plus[1]), maxYears: null, raw: text };

  const atLeast = lower.match(/(?:min(?:imum)?|at least|over)\s*(\d+(?:\.\d+)?)/);
  if (atLeast) return { minYears: Number(atLeast[1]), maxYears: null, raw: text };

  const upTo = lower.match(/(?:up to|max(?:imum)?|under)\s*(\d+(?:\.\d+)?)/);
  if (upTo) return { minYears: null, maxYears: Number(upTo[1]), raw: text };

  const single = lower.match(/(\d+(?:\.\d+)?)\s*(?:\+)?\s*(?:years?|yrs?)/);
  if (single) return { minYears: Number(single[1]), maxYears: null, raw: text };

  return { minYears: null, maxYears: null, raw: text };
}

export function parsePostedAt(input: string | Date | null | undefined, now: Date): Date | null {
  if (!input) return null;
  if (input instanceof Date) return Number.isNaN(input.getTime()) ? null : input;

  const text = input.trim();
  if (!text) return null;

  const lower = text.toLowerCase();
  if (/just now|today|few (hours|minutes)|hours? ago|minutes? ago/.test(lower)) return now;
  if (/yesterday|1 day ago|a day ago/.test(lower)) {
    return new Date(now.getTime() - 24 * 60 * 60 * 1000);
  }

  const relative = lower.match(/(\d+)\s*(day|week|month)s?\s*ago/);
  if (relative) {
    const amount = Number(relative[1]);
    const unitDays = relative[2] === 'week' ? 7 : relative[2] === 'month' ? 30 : 1;
    return new Date(now.getTime() - amount * unitDays * 24 * 60 * 60 * 1000);
  }

  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export interface NormalizeOptions {
  now?: Date;
}

/**
 * Raw source output -> the canonical schema. Throws only when a job lacks the
 * minimum identity needed to be useful (title, company, and a URL): everything
 * else degrades to null rather than being invented.
 */
export function normalizeJob(raw: RawJob, options: NormalizeOptions = {}): NormalizedJob {
  const now = options.now ?? new Date();

  const title = raw.title?.trim();
  const company = raw.company?.trim();
  const url = raw.url?.trim();

  if (!title) throw new NormalizationError('job has no title', raw);
  if (!company) throw new NormalizationError('job has no company', raw);
  if (!url) throw new NormalizationError('job has no URL', raw);

  const description = htmlToText(raw.description ?? '');
  const location = raw.location?.trim() || null;
  const salary = parseSalary(raw.salary);
  const experienceRequired = parseExperience(raw.experience);

  const remote = parseRemote(raw.remote, location, title, description.slice(0, 1500));

  const skills = [...new Set(raw.skills.map((s) => s.trim()).filter(Boolean))];

  // A source with no stable id of its own still needs one that survives re-runs.
  const externalId =
    raw.externalId?.trim() || sha256(`${raw.source}|${normalizeUrl(url)}`).slice(0, 32);

  const candidate: NormalizedJob = {
    source: raw.source,
    externalId,
    company,
    title,
    description,
    location,
    remote,
    salary,
    experienceRequired,
    skills,
    url,
    applicationUrl: raw.applicationUrl?.trim() || null,
    postedAt: parsePostedAt(raw.postedAt, now),
    firstSeenAt: now,
    lastSeenAt: now,
    fingerprint: computeFingerprint({ company, title, location, url }),
    contentHash: computeContentHash({
      title,
      company,
      description,
      salaryRaw: salary?.raw ?? null,
      experienceRaw: experienceRequired?.raw ?? null,
      skills,
    }),
    rawData: raw.rawData,
  };

  const result = NormalizedJobSchema.safeParse(candidate);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new NormalizationError(`normalized job failed validation: ${issues}`, raw);
  }
  return result.data;
}
