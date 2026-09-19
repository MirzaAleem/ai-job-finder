import type { Logger } from '../util/logger.js';

interface RuleGroup {
  agents: string[];
  allow: string[];
  disallow: string[];
  crawlDelay: number | null;
}

export interface RobotsPolicy {
  isAllowed(pathname: string): boolean;
  crawlDelaySeconds: number | null;
  /** The user-agent group that matched, for logging and honesty. */
  matchedAgent: string;
}

export class RobotsDisallowedError extends Error {
  constructor(url: string, agent: string) {
    super(`robots.txt disallows "${url}" for user-agent "${agent}". Refusing to fetch.`);
    this.name = 'RobotsDisallowedError';
  }
}

export function parseRobotsTxt(text: string): RuleGroup[] {
  const groups: RuleGroup[] = [];
  let current: RuleGroup | null = null;
  let lastLineWasAgent = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.split('#')[0]?.trim() ?? '';
    if (!line) continue;

    const separator = line.indexOf(':');
    if (separator === -1) continue;

    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (field === 'user-agent') {
      // Consecutive User-agent lines share one rule block.
      if (!current || !lastLineWasAgent) {
        current = { agents: [], allow: [], disallow: [], crawlDelay: null };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastLineWasAgent = true;
      continue;
    }

    lastLineWasAgent = false;
    if (!current) continue;

    if (field === 'allow' && value) current.allow.push(value);
    else if (field === 'disallow') {
      // "Disallow:" with an empty value means allow everything.
      if (value) current.disallow.push(value);
    } else if (field === 'crawl-delay') {
      const delay = Number(value);
      if (Number.isFinite(delay)) current.crawlDelay = delay;
    }
  }

  return groups;
}

/** Convert a robots path pattern (supporting * and $) to a regex. */
function patternToRegex(pattern: string): RegExp {
  let source = '';
  for (const char of pattern) {
    if (char === '*') source += '.*';
    else if (char === '$') source += '$';
    else source += char.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}`);
}

function matchLength(patterns: string[], pathname: string): number {
  let longest = -1;
  for (const pattern of patterns) {
    if (patternToRegex(pattern).test(pathname)) {
      longest = Math.max(longest, pattern.length);
    }
  }
  return longest;
}

/**
 * Build a policy for one user-agent. Group selection follows the standard:
 * the most specific matching agent wins, falling back to `*`.
 */
export function buildPolicy(groups: RuleGroup[], userAgent: string): RobotsPolicy {
  const agent = userAgent.toLowerCase();

  let best: RuleGroup | null = null;
  let bestSpecificity = -1;
  let matchedAgent = '*';

  for (const group of groups) {
    for (const candidate of group.agents) {
      if (candidate === '*') {
        if (bestSpecificity < 0) {
          best = group;
          bestSpecificity = 0;
          matchedAgent = '*';
        }
        continue;
      }
      if (agent.includes(candidate) && candidate.length > bestSpecificity) {
        best = group;
        bestSpecificity = candidate.length;
        matchedAgent = candidate;
      }
    }
  }

  const group = best;
  return {
    matchedAgent,
    crawlDelaySeconds: group?.crawlDelay ?? null,
    isAllowed(pathname: string): boolean {
      if (!group) return true;
      const allowLength = matchLength(group.allow, pathname);
      const disallowLength = matchLength(group.disallow, pathname);
      if (disallowLength === -1) return true;
      // The longer, more specific rule wins; Allow wins ties.
      return allowLength >= disallowLength;
    },
  };
}

const ALLOW_ALL: RobotsPolicy = {
  isAllowed: () => true,
  crawlDelaySeconds: null,
  matchedAgent: '*',
};

const DENY_ALL: RobotsPolicy = {
  isAllowed: () => false,
  crawlDelaySeconds: null,
  matchedAgent: '*',
};

/**
 * Fetches and caches robots.txt per origin and gates every navigation.
 *
 * Failure policy: a 404 (no robots file) permits crawling, which is the standard
 * reading. Any other failure denies — if we cannot read the rules, we do not act.
 */
export class RobotsGate {
  private readonly cache = new Map<string, RobotsPolicy>();

  constructor(
    private readonly userAgent: string,
    private readonly logger: Logger,
    private readonly enabled = true,
  ) {}

  async policyFor(targetUrl: string): Promise<RobotsPolicy> {
    if (!this.enabled) return ALLOW_ALL;

    const url = new URL(targetUrl);
    const cached = this.cache.get(url.origin);
    if (cached) return cached;

    let policy: RobotsPolicy;
    try {
      const response = await fetch(`${url.origin}/robots.txt`, {
        headers: { 'User-Agent': this.userAgent },
        signal: AbortSignal.timeout(15_000),
      });

      if (response.status === 404 || response.status === 410) {
        this.logger.debug('ROBOTS', 'no robots.txt — treating as allow', { origin: url.origin });
        policy = ALLOW_ALL;
      } else if (!response.ok) {
        this.logger.warn('ROBOTS', 'could not read robots.txt — refusing to crawl', {
          origin: url.origin,
          status: response.status,
        });
        policy = DENY_ALL;
      } else {
        const text = await response.text();
        // A site serving an anti-bot interstitial instead of a robots file is
        // telling us plainly that it does not want automated clients.
        if (/<html|<!doctype/i.test(text.slice(0, 200))) {
          this.logger.warn(
            'ROBOTS',
            'robots.txt returned an HTML challenge page — refusing to crawl',
            {
              origin: url.origin,
            },
          );
          policy = DENY_ALL;
        } else {
          policy = buildPolicy(parseRobotsTxt(text), this.userAgent);
          this.logger.info('ROBOTS', 'policy loaded', {
            origin: url.origin,
            matchedAgent: policy.matchedAgent,
            crawlDelaySeconds: policy.crawlDelaySeconds,
          });
        }
      }
    } catch (err) {
      this.logger.warn('ROBOTS', 'robots.txt fetch failed — refusing to crawl', {
        origin: url.origin,
        error: err instanceof Error ? err.message : String(err),
      });
      policy = DENY_ALL;
    }

    this.cache.set(url.origin, policy);
    return policy;
  }

  /** Hard precondition. Throws rather than returning false, so it cannot be ignored. */
  async assertAllowed(targetUrl: string): Promise<void> {
    const policy = await this.policyFor(targetUrl);
    const { pathname, search } = new URL(targetUrl);
    if (!policy.isAllowed(`${pathname}${search}`)) {
      throw new RobotsDisallowedError(targetUrl, policy.matchedAgent);
    }
  }
}
