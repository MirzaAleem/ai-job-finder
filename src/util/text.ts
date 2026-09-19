const BLOCK_TAGS = /<\/?(p|div|br|li|tr|h[1-6]|section|article|ul|ol|table)[^>]*>/gi;

/**
 * Turn a possibly-HTML description into plain text.
 * We never send raw HTML to a model: it is mostly tokens with no signal.
 */
export function htmlToText(input: string): string {
  return input
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(BLOCK_TAGS, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t\u00a0\u2000-\u200b]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .trim();
}

/** Truncate on a word boundary, marking the cut so the model knows it is partial. */
export function truncate(input: string, maxChars: number): string {
  if (input.length <= maxChars) return input;
  const cut = input.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(' ');
  const body = lastSpace > maxChars * 0.8 ? cut.slice(0, lastSpace) : cut;
  return `${body.trimEnd()}\n[...description truncated...]`;
}

/** Aggressive normalisation used for fingerprints and comparisons only. */
export function normalizeKey(input: string | null | undefined): string {
  if (!input) return '';
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

const COMPANY_SUFFIXES =
  /\b(pvt|private|ltd|limited|llc|llp|inc|incorporated|corp|corporation|technologies|technology|solutions|services|systems|labs|software|india|global|group|co)\b/g;

/** Company names vary wildly between boards; strip the legal noise before matching. */
export function normalizeCompany(input: string | null | undefined): string {
  return normalizeKey(input).replace(COMPANY_SUFFIXES, ' ').replace(/\s+/g, ' ').trim();
}

const TITLE_NOISE =
  /\b(urgent|urgently|immediate|immediately|hiring|apply now|wfh|work from home|job|jobs|opening|openings|vacancy|vacancies|required|req|opportunity|fresher|experienced|male|female|joiner|joiners|immediate joiners)\b/g;

/** Abbreviations that are the same word, so titles compare like for like. */
const TITLE_ABBREVIATIONS: Array<[RegExp, string]> = [
  [/\bsr\b/g, 'senior'],
  [/\bjr\b/g, 'junior'],
  [/\bdev\b/g, 'developer'],
  [/\bengg?\b/g, 'engineer'],
  [/\bmgr\b/g, 'manager'],
  [/\barch\b/g, 'architect'],
  [/\bswe\b/g, 'software engineer'],
  [/\bsde\b/g, 'software engineer'],
  [/\bfullstack\b/g, 'full stack'],
  [/\bnodejs\b/g, 'node js'],
];

export function normalizeTitle(input: string | null | undefined): string {
  let title = normalizeKey(input).replace(TITLE_NOISE, ' ');
  for (const [pattern, replacement] of TITLE_ABBREVIATIONS) {
    title = title.replace(pattern, replacement);
  }
  return title.replace(/\s+/g, ' ').trim();
}

const TRACKING_PARAMS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
  'gclid',
  'fbclid',
  'ref',
  'referrer',
  'source',
  'src',
  'trk',
  'trackingid',
  'sid',
  'session_id',
  'position',
  'pagenum',
  'searchid',
]);

/** Canonical URL form for dedupe: no scheme/host casing, no tracking, no trailing slash. */
export function normalizeUrl(input: string | null | undefined): string {
  if (!input) return '';
  try {
    const url = new URL(input.trim());
    url.hash = '';
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');
    url.protocol = 'https:';
    for (const key of [...url.searchParams.keys()]) {
      if (TRACKING_PARAMS.has(key.toLowerCase())) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    let out = url.toString();
    if (out.endsWith('/')) out = out.slice(0, -1);
    return out.toLowerCase();
  } catch {
    return input.trim().toLowerCase().replace(/\/+$/, '');
  }
}

/** Jaccard similarity over word sets. Cheap, and good enough to be conservative with. */
export function tokenSetSimilarity(a: string, b: string): number {
  const setA = new Set(a.split(' ').filter(Boolean));
  const setB = new Set(b.split(' ').filter(Boolean));
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const token of setA) if (setB.has(token)) intersection += 1;
  return intersection / (setA.size + setB.size - intersection);
}

export function containsAnyKeyword(haystack: string, needles: string[]): string | null {
  const hay = ` ${normalizeKey(haystack)} `;
  for (const needle of needles) {
    const norm = normalizeKey(needle);
    if (norm && hay.includes(` ${norm} `)) return needle;
    // also allow substring for multi-word/partial keywords
    if (norm && norm.includes(' ') && hay.includes(norm)) return needle;
  }
  return null;
}
