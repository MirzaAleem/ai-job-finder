import type { Env } from './env.js';

/**
 * Every setting the dashboard exposes, with the prose that explains it.
 *
 * This is the single source of truth for the settings API, the settings form,
 * and the drift test that keeps both honest. The help text is carried over from
 * .env.example, which already explains these knobs well — keep the two in sync
 * when either changes.
 *
 * Deliberately excluded keys are listed in EXCLUDED_KEYS below rather than
 * being silently absent, so a new variable in EnvSchema fails the drift test
 * until someone decides which list it belongs in.
 */

export type EnvKey = keyof Env & string;

export type SettingType = 'string' | 'number' | 'boolean' | 'enum' | 'secret' | 'path' | 'csv';

export type SettingGroupId =
  'local' | 'cloud' | 'economy' | 'scoring' | 'sources' | 'scraping' | 'files' | 'advanced';

export interface SettingField {
  key: EnvKey;
  group: SettingGroupId;
  type: SettingType;
  label: string;
  help: string;
  options?: readonly string[];
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  placeholder?: string;
  /** The running process already read this; a change needs a restart. */
  restartRequired?: boolean;
  /** Shown with a warning affordance. Still editable — this is your machine. */
  caution?: string;
  /** Owned by another view, so this one shows it read-only with a pointer. */
  managedBy?: { view: string; label: string };
}

export interface SettingGroup {
  id: SettingGroupId;
  title: string;
  /** The concept no single field can explain on its own. */
  blurb: string;
  advanced?: boolean;
}

export const SETTING_GROUPS: readonly SettingGroup[] = [
  {
    id: 'local',
    title: 'Local model',
    blurb:
      'Ollama runs on your own machine and evaluates every job first. Nothing leaves your ' +
      'computer unless cloud escalation is switched on below.',
  },
  {
    id: 'cloud',
    title: 'Cloud escalation',
    blurb:
      'The cloud model is an expert second opinion, not the default. A job is sent to it only ' +
      'when the local model is unsure — confidence below the threshold, or enough soft flags ' +
      'raised at once. With a healthy local model and a threshold of 0.80, most runs make zero ' +
      'cloud calls.',
  },
  {
    id: 'economy',
    title: 'Batching and caching',
    blurb:
      'How much work is packed into each request to the local model, and how much of it can be ' +
      'skipped entirely. An unchanged job is never re-evaluated, which is what makes repeat ' +
      'runs nearly free.',
  },
  {
    id: 'scoring',
    title: 'Scoring thresholds',
    blurb:
      'Every evaluated job gets a score from 0 to 100. These three cut-offs turn that score ' +
      'into the recommendation you see in the job list. They must stay in descending order.',
  },
  {
    id: 'sources',
    title: 'Sources',
    blurb: 'Where postings come from. Which sources are switched on is managed in Sources.',
  },
  {
    id: 'scraping',
    title: 'Scraping and politeness',
    blurb:
      'How the browser behaves when it visits a career page. These defaults are deliberately ' +
      'conservative: you are a guest on someone else’s server.',
  },
  {
    id: 'files',
    title: 'Files and logging',
    blurb: 'Where exports are written, and how much detail runs report.',
  },
  {
    id: 'advanced',
    title: 'Advanced',
    blurb:
      'Rarely changed, and easy to get wrong. Everything here takes effect only after the ' +
      'dashboard is restarted.',
    advanced: true,
  },
];

export const SETTING_FIELDS: readonly SettingField[] = [
  // ---------------------------------------------------------------- local ---
  {
    key: 'OLLAMA_MODEL',
    group: 'local',
    type: 'string',
    label: 'Model',
    help: 'Any model installed in Ollama. Pull more with `ollama pull qwen3:8b`.',
    placeholder: 'llama3.1:8b',
  },
  {
    key: 'OLLAMA_BASE_URL',
    group: 'local',
    type: 'string',
    label: 'Ollama address',
    help: 'Where Ollama is listening. Change this only if you run it on another machine.',
    placeholder: 'http://localhost:11434',
  },
  {
    key: 'OLLAMA_TIMEOUT_MS',
    group: 'local',
    type: 'number',
    label: 'Request timeout',
    help:
      'Batched 8B inference genuinely takes minutes. If runs are timing out, raise this rather ' +
      'than lowering the batch size.',
    unit: 'ms',
    min: 1000,
  },
  {
    key: 'OLLAMA_NUM_CTX',
    group: 'local',
    type: 'number',
    label: 'Context window',
    help:
      'How much text the model can consider at once. Raise it if you increase the batch size ' +
      'or the description limit, or jobs at the end of a batch will be silently truncated.',
    unit: 'tokens',
    min: 512,
  },

  // ---------------------------------------------------------------- cloud ---
  {
    key: 'CLOUD_ESCALATION_ENABLED',
    group: 'cloud',
    type: 'boolean',
    label: 'Use a cloud model for uncertain jobs',
    help: 'Turn this off to run entirely on your own machine, at no cost and with no network calls.',
  },
  {
    key: 'CLOUD_PROVIDER',
    group: 'cloud',
    type: 'enum',
    label: 'Provider',
    options: ['openrouter', 'gemini', 'none'],
    help: 'Which service to escalate to. Their API keys are not interchangeable.',
  },
  {
    key: 'OPENROUTER_API_KEY',
    group: 'cloud',
    type: 'secret',
    label: 'OpenRouter API key',
    help: 'Starts with sk-or-v1-. Stored in your .env file and never sent anywhere else.',
    placeholder: 'sk-or-v1-…',
  },
  {
    key: 'OPENROUTER_MODEL',
    group: 'cloud',
    type: 'string',
    label: 'OpenRouter model',
    help: 'Any model slug OpenRouter accepts.',
    placeholder: 'openai/gpt-5-nano',
  },
  {
    key: 'GEMINI_API_KEY',
    group: 'cloud',
    type: 'secret',
    label: 'Gemini API key',
    help: 'From Google AI Studio. Used only when the provider above is set to gemini.',
  },
  {
    key: 'GEMINI_MODEL',
    group: 'cloud',
    type: 'string',
    label: 'Gemini model',
    help: 'Any model the Gemini API accepts.',
    placeholder: 'gemini-3.6-flash',
  },
  {
    key: 'LLM_CONFIDENCE_THRESHOLD',
    group: 'cloud',
    type: 'number',
    label: 'Escalate below this confidence',
    help:
      'The local model reports how sure it is. Below this, the job is re-checked by the cloud ' +
      'model. Higher means more cloud calls and more cost.',
    min: 0,
    max: 1,
    step: 0.05,
  },
  {
    key: 'LLM_SOFT_FLAG_THRESHOLD',
    group: 'cloud',
    type: 'number',
    label: 'Soft flags needed to escalate',
    help:
      'Small models flag "the posting didn’t state a salary" constantly. Such soft flags only ' +
      'trigger escalation once this many are raised at once. Set it to 1 and expect far more ' +
      'cloud calls.',
    min: 1,
    step: 1,
  },
  {
    key: 'CLOUD_MAX_REQUESTS_PER_RUN',
    group: 'cloud',
    type: 'number',
    label: 'Maximum cloud calls per run',
    help: 'A hard ceiling, so one bad batch cannot drain your account.',
    min: 0,
    step: 1,
  },
  {
    key: 'CLOUD_INPUT_COST_PER_MTOK',
    group: 'cloud',
    type: 'number',
    label: 'Input price per million tokens',
    help:
      'Used only to estimate what a run cost. Set it to your model’s real price — the default ' +
      'is a cheap-flash-tier guess, not a quote.',
    unit: 'USD',
    min: 0,
    step: 0.01,
  },
  {
    key: 'CLOUD_OUTPUT_COST_PER_MTOK',
    group: 'cloud',
    type: 'number',
    label: 'Output price per million tokens',
    help: 'As above, for tokens the model generates.',
    unit: 'USD',
    min: 0,
    step: 0.01,
  },

  // -------------------------------------------------------------- economy ---
  {
    key: 'LLM_BATCH_SIZE',
    group: 'economy',
    type: 'number',
    label: 'Jobs per request',
    help:
      'How many jobs are evaluated in one call to the local model. Higher is faster and cheaper ' +
      'but needs a larger context window.',
    min: 1,
    step: 1,
  },
  {
    key: 'LLM_MAX_DESCRIPTION_CHARS',
    group: 'economy',
    type: 'number',
    label: 'Description limit',
    help: 'Job descriptions are truncated to this length before being sent to any model.',
    unit: 'characters',
    min: 100,
    step: 100,
  },
  {
    key: 'LLM_CACHE_ENABLED',
    group: 'economy',
    type: 'boolean',
    label: 'Skip jobs that have not changed',
    help:
      'Re-uses the previous evaluation when a posting’s text is identical. This is what makes ' +
      'a daily run take seconds instead of minutes.',
  },

  // -------------------------------------------------------------- scoring ---
  {
    key: 'SCORE_HIGH_PRIORITY',
    group: 'scoring',
    type: 'number',
    label: 'High priority at',
    help: 'Jobs scoring at least this are surfaced first. Apply today.',
    min: 0,
    max: 100,
    step: 1,
  },
  {
    key: 'SCORE_APPLY',
    group: 'scoring',
    type: 'number',
    label: 'Apply at',
    help: 'Worth applying to.',
    min: 0,
    max: 100,
    step: 1,
  },
  {
    key: 'SCORE_CONSIDER',
    group: 'scoring',
    type: 'number',
    label: 'Consider at',
    help: 'Worth a look. Anything below this is marked Skip.',
    min: 0,
    max: 100,
    step: 1,
  },

  // -------------------------------------------------------------- sources ---
  {
    key: 'SOURCES_ENABLED',
    group: 'sources',
    type: 'csv',
    label: 'Enabled sources',
    help: 'Which sources a run fetches from.',
    managedBy: { view: 'sources', label: 'Manage in Sources' },
  },
  {
    key: 'IMPORT_FILE',
    group: 'sources',
    type: 'path',
    label: 'Imported file',
    help: 'The CSV or JSON file the import source reads.',
    managedBy: { view: 'sources', label: 'Manage in Sources' },
  },
  {
    key: 'SEARCH_QUERIES',
    group: 'sources',
    type: 'csv',
    label: 'Search terms',
    help: 'Comma-separated terms, for sources that support searching.',
    placeholder: 'backend engineer, platform engineer',
  },
  {
    key: 'SCRAPE_MAX_PAGES',
    group: 'sources',
    type: 'number',
    label: 'Maximum pages per board',
    help:
      'An upper bound on how far to page through a job board, so a changed page layout cannot ' +
      'send the scraper into a loop.',
    min: 1,
    step: 1,
  },

  // ------------------------------------------------------------- scraping ---
  {
    key: 'SCRAPE_DELAY_MS',
    group: 'scraping',
    type: 'number',
    label: 'Delay between pages',
    help: 'How long to wait between requests to the same site.',
    unit: 'ms',
    min: 0,
    step: 250,
    caution: 'Lowering this hammers other people’s servers. The default is already brisk.',
  },
  {
    key: 'RESPECT_ROBOTS_TXT',
    group: 'scraping',
    type: 'boolean',
    label: 'Respect robots.txt',
    help: 'Every page fetch is checked against the site’s robots.txt first.',
    caution:
      'Turning this off disables the gate entirely and may breach a site’s terms of use. ' +
      'Leave it on.',
  },
  {
    key: 'PLAYWRIGHT_HEADLESS',
    group: 'scraping',
    type: 'boolean',
    label: 'Run the browser invisibly',
    help: 'Turn this off to watch the browser work, which is useful when debugging selectors.',
  },
  {
    key: 'BROWSER_TIMEOUT_MS',
    group: 'scraping',
    type: 'number',
    label: 'Page load timeout',
    help: 'How long to wait for a career page to load before giving up on it.',
    unit: 'ms',
    min: 1000,
  },

  // ---------------------------------------------------------------- files ---
  {
    key: 'OUTPUT_DIR',
    group: 'files',
    type: 'path',
    label: 'Export folder',
    help: 'Where CSV and JSON exports are written, relative to the project folder.',
  },
  {
    key: 'LOG_LEVEL',
    group: 'files',
    type: 'enum',
    label: 'Log detail',
    options: ['debug', 'info', 'warn', 'error'],
    help: 'How much detail a run reports. Use debug when something is not working.',
    restartRequired: true,
  },

  // ------------------------------------------------------------- advanced ---
  {
    key: 'SQLITE_PATH',
    group: 'advanced',
    type: 'path',
    label: 'Database file',
    help: 'One SQLite file holding every job, evaluation and application you have tracked.',
    restartRequired: true,
    caution:
      'Pointing this somewhere new starts an empty history. Your existing data is not moved or ' +
      'deleted — it stays in the old file.',
  },
  {
    key: 'DASHBOARD_PORT',
    group: 'advanced',
    type: 'number',
    label: 'Dashboard port',
    help: 'The port this page is served on.',
    min: 1,
    max: 65535,
    step: 1,
    restartRequired: true,
  },
  {
    key: 'JOB_RUN_CRON',
    group: 'advanced',
    type: 'string',
    label: 'Schedule',
    help:
      'A cron expression used by `pnpm jobs:schedule`. "0 8 * * *" means 8am daily. Scheduling ' +
      'is still started from a terminal.',
    placeholder: '0 8 * * *',
  },
];

/**
 * Keys intentionally not surfaced, each with the reason.
 *
 * Nothing is removed by being here — they remain editable by hand in .env.
 */
export const EXCLUDED_KEYS: Readonly<Record<string, string>> = {
  NODE_ENV: 'a development flag, not a user setting',
  OPENROUTER_BASE_URL: 'changing the API endpoint is a debugging concern',
  GEMINI_BASE_URL: 'changing the API endpoint is a debugging concern',
  LLM_MAX_RETRIES: 'internal retry budget; escalation already covers a bad response',
  PROFILE_PATH: 'implied by the Profile editor',
  SOURCES_CONFIG_PATH: 'implied by the Sources editor',
};

export const SETTINGS_KEYS: ReadonlySet<string> = new Set(SETTING_FIELDS.map((f) => f.key));

/** Keys the settings API refuses to write, even though it displays them. */
export const READ_ONLY_KEYS: ReadonlySet<string> = new Set(
  SETTING_FIELDS.filter((f) => f.managedBy).map((f) => f.key),
);

export const RESTART_REQUIRED_KEYS: ReadonlySet<string> = new Set(
  SETTING_FIELDS.filter((f) => f.restartRequired).map((f) => f.key),
);
