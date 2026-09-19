import { sha256 } from '../util/hash.js';
import { normalizeCompany, normalizeKey, normalizeTitle, normalizeUrl } from '../util/text.js';

export interface FingerprintInput {
  company: string | null;
  title: string | null;
  location: string | null;
  url: string | null;
}

/**
 * Deterministic identity for a posting. Deliberately includes the URL: two
 * genuinely different openings at one company with the same title and city are
 * common, and collapsing them would silently hide a real job.
 */
export function computeFingerprint(input: FingerprintInput): string {
  const parts = [
    normalizeCompany(input.company),
    normalizeTitle(input.title),
    normalizeKey(input.location),
    normalizeUrl(input.url),
  ];
  return sha256(parts.join('|'));
}

/**
 * Identity of the *content*. Changing this is what triggers a re-evaluation, so
 * it covers exactly the fields a model's judgement depends on — and nothing
 * volatile like a view counter or a "posted 3 days ago" string.
 */
export function computeContentHash(input: {
  title: string;
  company: string;
  description: string;
  salaryRaw?: string | null;
  experienceRaw?: string | null;
  skills?: string[];
}): string {
  const parts = [
    normalizeTitle(input.title),
    normalizeCompany(input.company),
    normalizeKey(input.description),
    normalizeKey(input.salaryRaw ?? ''),
    normalizeKey(input.experienceRaw ?? ''),
    [...(input.skills ?? [])].map(normalizeKey).sort().join(','),
  ];
  return sha256(parts.join('|'));
}
