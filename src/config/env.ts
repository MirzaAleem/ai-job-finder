import 'dotenv/config';
import { z } from 'zod';

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : v.toLowerCase() === 'true'));

const num = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : Number(v)))
    .pipe(z.number());

export const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  /** Path to the SQLite database file. Created on first run. */
  SQLITE_PATH: z.string().min(1).default('data/job-finder.db'),

  // --- Local LLM (default provider) ---
  OLLAMA_BASE_URL: z.string().min(1).default('http://localhost:11434'),
  OLLAMA_MODEL: z.string().min(1).default('llama3.1:8b'),
  OLLAMA_TIMEOUT_MS: num(300_000),
  OLLAMA_NUM_CTX: num(8192),

  // --- Cloud LLM (escalation only) ---
  CLOUD_PROVIDER: z.enum(['openrouter', 'gemini', 'none']).default('openrouter'),
  CLOUD_ESCALATION_ENABLED: bool(true),
  LLM_CONFIDENCE_THRESHOLD: num(0.8),
  /** Soft "the posting didn't say" flags needed before they alone escalate. */
  LLM_SOFT_FLAG_THRESHOLD: num(2),
  /** Hard ceiling on cloud calls per run; a runaway loop cannot drain the account. */
  CLOUD_MAX_REQUESTS_PER_RUN: num(25),

  OPENROUTER_API_KEY: z.string().optional(),
  OPENROUTER_MODEL: z.string().default('openai/gpt-5-nano'),
  OPENROUTER_BASE_URL: z.string().default('https://openrouter.ai/api/v1'),

  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().default('gemini-3.6-flash'),
  GEMINI_BASE_URL: z.string().default('https://generativelanguage.googleapis.com/v1beta'),

  /** USD per 1M tokens, used only for the run cost estimate. */
  CLOUD_INPUT_COST_PER_MTOK: num(0.1),
  CLOUD_OUTPUT_COST_PER_MTOK: num(0.4),

  // --- LLM economy ---
  LLM_BATCH_SIZE: num(5),
  LLM_MAX_DESCRIPTION_CHARS: num(4000),
  LLM_MAX_RETRIES: num(1),
  LLM_CACHE_ENABLED: bool(true),

  // --- Scoring thresholds ---
  SCORE_HIGH_PRIORITY: num(90),
  SCORE_APPLY: num(80),
  SCORE_CONSIDER: num(65),

  // --- Sources ---
  SOURCES_ENABLED: z.string().default('mock'),
  /** Search terms for sources that support querying, comma-separated. */
  SEARCH_QUERIES: z.string().default(''),
  /** Upper bound on paginated list views, so a selector change cannot run away. */
  SCRAPE_MAX_PAGES: num(2),
  IMPORT_FILE: z.string().optional(),
  SOURCES_CONFIG_PATH: z.string().default('config/sources.yaml'),

  // --- Browser ---
  PLAYWRIGHT_HEADLESS: bool(true),
  BROWSER_TIMEOUT_MS: num(45_000),
  /** Politeness delay between navigations, in ms. */
  SCRAPE_DELAY_MS: num(2500),
  RESPECT_ROBOTS_TXT: bool(true),

  // --- Misc ---
  DASHBOARD_PORT: num(4321),

  PROFILE_PATH: z.string().default('config/profile.yaml'),
  OUTPUT_DIR: z.string().default('output'),
  JOB_RUN_CRON: z.string().default('0 8 * * *'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | null = null;

export function loadEnv(overrides: NodeJS.ProcessEnv = process.env): Env {
  if (cached && overrides === process.env) return cached;
  const parsed = EnvSchema.safeParse(overrides);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  if (overrides === process.env) cached = parsed.data;
  return parsed.data;
}

/** Test seam: forget the memoised env. */
export function resetEnvCache(): void {
  cached = null;
}

export function enabledSources(env: Env): string[] {
  return env.SOURCES_ENABLED.split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}
