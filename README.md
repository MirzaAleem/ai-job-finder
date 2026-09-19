# AI Job Finder

A personal job-discovery pipeline. It fetches job postings, normalizes and
deduplicates them, filters them against your profile, ranks them with an LLM, and
writes a CSV you use to apply **manually**.

It ships with a local web dashboard for triaging results and tracking what you have
applied to. It does not apply to jobs for you — that is deliberate, and out of scope.

The governing design constraint is **local-first, cloud-second**: a local model
via Ollama evaluates every job that survives filtering. A cloud model is called
only when the local one is genuinely uncertain. A typical daily run costs $0.00.

## Demo

<video
  src="https://raw.githubusercontent.com/MirzaAleem/ai-job-finder/assets/job-finder-promo.mp4"
  controls
  muted
  playsinline
  width="100%"></video>

A two-minute tour: running a search, triaging the board, filtering, reading the
model's reasoning, and reviewing run history.
[Download the video](https://raw.githubusercontent.com/MirzaAleem/ai-job-finder/assets/job-finder-promo.mp4)
if it does not play inline.

---

## Contents

- [Demo](#demo)
- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Installation](#installation)
- [Database](#database)
- [Ollama setup](#ollama-setup)
- [Cloud provider setup](#cloud-provider-setup)
- [Configuring your profile](#configuring-your-profile)
- [Running your first search](#running-your-first-search)
- [Output](#output)
- [Dashboard](#dashboard)
- [Commands](#commands)
- [Local / cloud escalation](#local--cloud-escalation)
- [Cost optimization](#cost-optimization)
- [Job sources](#job-sources)
- [Adding a job source](#adding-a-job-source)
- [Scheduling](#scheduling)
- [Testing](#testing)
- [Security](#security)
- [Limitations](#limitations)
- [Design decisions](#design-decisions)

---

## How it works

```
                    JOB FINDER
                        │
              ┌─────────┴─────────┐
              │                   │
        Local Processing      Job Sources
              │            mock / import / careers
              │                   │
              └─────────┬─────────┘
                        │
                  Normalize Jobs          ← Zod-validated common schema
                        │
                   Deduplicate            ← id → URL → fingerprint → fuzzy
                        │
                Deterministic Filter      ← no LLM, no cost
                        │
                   Cache lookup           ← unchanged job? stop here, free
                        │
                        ▼
                  Ollama Local LLM        ← batched, JSON-constrained
                        │
                   confident?
             ┌──────────┴──────────┐
            YES                    NO
             │                      │
             │              Cloud LLM (OpenRouter / Gemini)
             │                      │
             └──────────┬───────────┘
                        │
                  Final Ranking
                        │
                     SQLite
                        │
                        ▼
                     CSV/JSON
```

Each stage discards work so the next one costs less. By the time anything
reaches a model, the obviously-unsuitable jobs are already gone.

---

## Requirements

| Requirement   | Notes                                                                  |
| ------------- | ---------------------------------------------------------------------- |
| Node.js       | 20 or newer (developed on v24)                                         |
| pnpm          | `corepack enable && corepack prepare pnpm@9.15.0 --activate`           |
| SQLite        | **Nothing to install.** Bundled with the app; the database is one file |
| Ollama        | Running locally, with at least one model pulled                        |
| Cloud LLM key | **Optional.** Without one the pipeline runs local-only                 |

---

## Installation

```bash
corepack enable
pnpm install

# Only if you plan to use browser-based sources:
pnpm exec playwright install chromium

cp .env.example .env
cp config/profile.example.yaml config/profile.yaml
```

Then edit `.env` and `config/profile.yaml`. Both are gitignored.

---

## Database

SQLite, in a single file. There is no server to install, no service to start and
no connection string to get right — the file and its parent directory are created
on the first run.

```bash
# In .env. This is the default; you can leave it alone.
SQLITE_PATH=data/job-finder.db
```

It stores job history, evaluations, application tracking and run statistics.
History is what makes repeat runs nearly free: an unchanged job is never
re-evaluated. The schema is applied on every startup and is idempotent, so
upgrading the project does not need a migration step.

The file is yours. Copy it, back it up, or open it in any SQLite browser to query
your own job history directly. It is gitignored.

Write-ahead logging is enabled, so the dashboard can read while a run is writing.

You can also run without persistence entirely using `--no-db`. You lose history
and caching, so every run re-evaluates everything.

---

## Ollama setup

```bash
# macOS
brew install ollama
ollama serve

# Pull a model — any of these work
ollama pull qwen3:8b
ollama pull llama3.1:8b
ollama pull gemma3:4b
```

The model name is **never hardcoded**. Set it in `.env`:

```bash
OLLAMA_MODEL=llama3.1:8b
```

To see what you actually have installed, and switch between them:

```bash
pnpm jobs:models            # list models from the running Ollama daemon
pnpm jobs:models --select   # pick one; writes OLLAMA_MODEL into .env
```

### Choosing a model — honestly

An 8B model is the realistic floor for this task. It has to read a job
description, compare it to a structured profile, produce valid JSON, and — the
hard part — report _calibrated uncertainty_. Smaller models produce valid JSON
but poorly calibrated confidence, which means either missed escalations or a
flood of them.

Measured on this machine (Apple Silicon, `llama3.1:8b`, 10 jobs, batch size 5):

|                                       |                                |
| ------------------------------------- | ------------------------------ |
| Cold run, 10 jobs, 2 batched requests | **~5 minutes**                 |
| Warm run, same 10 jobs, all cached    | **1.2 seconds, 0 model calls** |

Batched inference is slow. `OLLAMA_TIMEOUT_MS` defaults to 300000 (5 minutes)
for this reason. If you hit timeouts, lower `LLM_BATCH_SIZE` before raising the
timeout further.

---

## Cloud provider setup

The cloud model is an **expert fallback**, not the default. It is entirely
optional — without a key, uncertain jobs keep their local evaluation and are
marked `degraded` in the JSON output.

Two providers are supported. Pick one with `CLOUD_PROVIDER`.

**OpenRouter** — keys look like `sk-or-v1-...`:

```bash
CLOUD_PROVIDER=openrouter
OPENROUTER_API_KEY=sk-or-v1-...
OPENROUTER_MODEL=openai/gpt-5-nano
```

**Google Gemini** — keys from Google AI Studio. **Not interchangeable with an
OpenRouter key**; each provider only accepts its own:

```bash
CLOUD_PROVIDER=gemini
GEMINI_API_KEY=...
GEMINI_MODEL=gemini-3.6-flash
```

To disable cloud escalation entirely:

```bash
CLOUD_ESCALATION_ENABLED=false
# or per-run:  pnpm jobs:run --no-cloud
```

### Cost estimates

`CLOUD_INPUT_COST_PER_MTOK` and `CLOUD_OUTPUT_COST_PER_MTOK` drive the cost
summary. **The defaults are a cheap-flash-tier guess, not a quote** — set them to
your model's real prices or the number printed at the end of each run is wrong.

If you use a _thinking_ model (Gemini 3.x, GPT-5 reasoning tiers), reasoning
tokens are billed as output and frequently exceed the answer itself. The Gemini
provider counts them; budget accordingly.

`CLOUD_MAX_REQUESTS_PER_RUN` (default 25) is a hard ceiling. Once hit, remaining
uncertain jobs keep their local evaluation and are marked degraded.

---

## Configuring your profile

```bash
cp config/profile.example.yaml config/profile.yaml
```

Edit it. Every value in the example is a placeholder. The file is gitignored
because it contains personal details, and it is validated with Zod on every run —
a typo in a key name is a startup error, not a silently ignored field.

The fields that most affect results:

| Field                                                       | Effect                                                                                      |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `targetRoles`                                               | Drives deterministic title filtering. Too narrow and good jobs never reach the model.       |
| `preferredLocations`                                        | A job with a _stated, non-matching_ location is dropped. Unstated is never dropped.         |
| `remotePreference`                                          | `REMOTE_ONLY` drops explicitly onsite/hybrid roles.                                         |
| `yearsOfExperience`                                         | Jobs demanding far more (or capped far below) are dropped.                                  |
| `salary.minimum`                                            | A job whose _stated ceiling_ is below this is dropped. Undisclosed salary is never dropped. |
| `excludedRoles` / `excludedKeywords` / `excludedIndustries` | Hard vetoes, applied before any LLM call.                                                   |

**Missing information never rejects a job.** A posting that does not state its
salary is not treated as low-paying; one with no stated location is not treated
as incompatible. Unknown is unknown, and the model is told so explicitly.

---

## Running your first search

Start with the mock source. It runs the entire pipeline against 25 built-in
fixture jobs with no network access at all:

```bash
pnpm jobs:run --source=mock
```

Expected output:

```
Fetching jobs...

  mock:               25

  Total fetched:      25

After deduplication:            24
After deterministic filtering:  10

Filtered out by rule:
  - location                 7
  - title relevance          3
  - excluded role            1
  - salary                   1
  - excluded industry        1
  - experience               1

Local LLM:
  model:              llama3.1:8b
  jobs evaluated:     10
  served from cache:  0
  batches:            2
  requests:           2
  cloud escalations:  0

Results:
  HIGH_PRIORITY:    2
  APPLY:            3
  CONSIDER:         1
  SKIP:             4
  (newly discovered: 10)

Cloud API:
  requests:         0
  estimated cost:   $0.0000

Output:
  output/jobs-2026-09-12.csv
  output/jobs-2026-09-12.json
```

Run it a second time and it finishes in about a second with zero model calls —
nothing changed, so nothing is re-evaluated.

---

## Output

Two files per run, in `OUTPUT_DIR`:

```
output/jobs-YYYY-MM-DD.csv
output/jobs-YYYY-MM-DD.json
```

CSV columns, sorted by score descending (newly discovered jobs first at equal
scores):

```
score, confidence, recommendation, company, title, location, remote, salary,
experienceRequired, postedAt, source, jobUrl, applicationUrl, matchingSkills,
missingSkills, reasons, concerns, providerUsed, isNew
```

Missing values are written as `unknown`, never as an empty cell. The file is
UTF-8 with a BOM so Excel opens it correctly.

The JSON carries everything the CSV does plus run metadata, escalation reasons
per job, and the `degraded` flag.

### Score thresholds

| Score  | Recommendation  |
| ------ | --------------- |
| 90–100 | `HIGH_PRIORITY` |
| 80–89  | `APPLY`         |
| 65–79  | `CONSIDER`      |
| 0–64   | `SKIP`          |

Configurable via `SCORE_HIGH_PRIORITY`, `SCORE_APPLY`, `SCORE_CONSIDER`. The
**score is authoritative** — the label is recomputed from it, so a model that
scores 95 and then labels it `SKIP` cannot produce a contradictory row.

---

## Dashboard

```bash
pnpm jobs:dashboard
```

Starts a local server (default `http://127.0.0.1:4321`) and opens it. It reads the same
database file the pipeline writes to, so whatever your last run produced is already
there — no import step, no file to drag in.

**It binds loopback only.** There is no authentication, because there is nothing to
authenticate to: the page is reachable from this machine and nowhere else. Nothing is
uploaded anywhere.

### What it does

- **Triage** — jobs ranked by score, with the model's reasons, concerns, matching and
  missing skills, and a badge when the evaluation came from the cloud or is unverified.
- **Track applications** — NEW → INTERESTED → APPLIED → INTERVIEWING → REJECTED / OFFER,
  or DISMISSED. Dismissed and rejected jobs drop out of the default view, so tomorrow's
  queue only shows what you have not dealt with. Every transition is timestamped.
- **Notes** per job, autosaved.
- **Filters** — search, recommendation, company, minimum score, new-only, sort order. The
  filter state lives in the URL, so a view you use often can be bookmarked.

### Keyboard triage

The list is built for keyboard use; that is the difference between clearing 60 jobs in
five minutes and in twenty.

| Key       | Action                    |
| --------- | ------------------------- |
| `j` / `k` | Next / previous job       |
| `Enter`   | Expand or collapse        |
| `o`       | Open the application page |
| `a`       | Mark applied              |
| `i`       | Mark interested           |
| `x`       | Dismiss                   |
| `u`       | Reset to new              |
| `/`       | Focus search              |
| `r`       | Refresh                   |
| `?`       | Shortcut help             |

### Options

```bash
pnpm jobs:dashboard --port=8080   # DASHBOARD_PORT also works
pnpm jobs:dashboard --no-open     # do not open a browser
```

Application state lives in its own `job_applications` collection, deliberately separate
from the scraped job documents. A re-run rewrites jobs; it must never be able to erase a
record of where you applied. There is a test for exactly that.

---

## Commands

```bash
pnpm dev             # watch mode
pnpm build           # compile to dist/
pnpm start           # run the compiled build
pnpm test            # full test suite
pnpm typecheck       # strict TypeScript, no emit
pnpm lint            # ESLint

pnpm jobs:run        # the main command: full pipeline
pnpm jobs:fetch      # fetch and store only — no LLM, no export
pnpm jobs:match      # fetch and evaluate, write no files
pnpm jobs:export     # re-export from the database without re-evaluating
pnpm jobs:dashboard  # web UI for triage and application tracking
pnpm jobs:models     # list Ollama models (--select to choose one)
pnpm jobs:schedule   # run on JOB_RUN_CRON until interrupted
```

Flags:

```
--source=<name>   Override SOURCES_ENABLED for this run
--no-db           Run without the database (no history, no caching)
--no-cloud        Disable cloud escalation for this run
--days=<n>        For `export`: how far back to look (default 7)
--select          For `models`: prompt and save the choice to .env
--port=<n>        For `dashboard`: port to listen on (default 4321)
--no-open         For `dashboard`: do not open a browser
```

---

## Local / cloud escalation

Every job that survives filtering goes to the local model first. The local model
returns:

```json
{
  "score": 92,
  "confidence": 0.94,
  "recommendation": "HIGH_PRIORITY",
  "matchingSkills": ["TypeScript", "Node.js", "PostgreSQL"],
  "missingSkills": ["Kubernetes"],
  "reasons": ["Strong backend match", "Experience requirement satisfied"],
  "concerns": [],
  "needsCloud": false,
  "escalationReason": null,
  "uncertainties": {
    "seniority": false,
    "experience": false,
    "salary": false,
    "requirements": false,
    "conflicting": false
  }
}
```

Output is validated with Zod. Anything that fails validation is retried once
with a repair prompt, then escalated.

### What triggers escalation

**Hard triggers** — any one alone sends the job to the cloud:

- confidence below `LLM_CONFIDENCE_THRESHOLD` (default 0.80)
- malformed response or missing required fields, after one retry
- the local model set `needsCloud: true`
- the posting contradicts itself (`uncertainties.conflicting`)

**Soft triggers** — "the posting did not say". These escalate only when at least
`LLM_SOFT_FLAG_THRESHOLD` (default 2) are set at once, or when one is set
_alongside_ low confidence:

- unclear seniority, experience, salary, or requirements

This distinction matters more than it looks. Small models flag "no salary
stated" on most postings, because most postings do not state a salary. Treating
each such flag as a reason to spend money escalated **8 of 10** jobs in testing.
Requiring a quorum brought that to **3 of 10** with no loss of judgement quality —
vagueness is supposed to show up in `confidence`, which is already a hard
trigger.

### What the cloud model is asked

It receives the candidate profile, the normalized job, **the local evaluation**,
and **the escalation reason** — and is instructed to verify independently rather
than agree. Both evaluations are stored; `providerUsed` records which one won.

If escalation is warranted but unavailable (no key, disabled, or budget spent),
the local result is kept and flagged `degraded: true`. The run never fails
because the cloud is absent.

---

## Cost optimization

In the order the pipeline applies them:

1. **Deterministic filtering before any LLM call.** In the sample run above, 14
   of 24 jobs were eliminated for free.
2. **Content-hash caching.** `sha256(title + company + description + salary +
experience + skills)`. Unchanged job → zero model calls. Changed → re-evaluated.
   A different model invalidates the cache, because a different model is a
   different judgement.
3. **Only relevant fields are sent.** HTML is stripped to text; descriptions are
   truncated at `LLM_MAX_DESCRIPTION_CHARS` (default 4000) with an explicit
   truncation marker so the model knows the text is partial.
4. **Batching.** `LLM_BATCH_SIZE` jobs per local request (default 5). A batch that
   fails to parse falls back to individual calls, so one bad job cannot poison
   four good ones.
5. **Deduplication before evaluation**, so the same posting from two sources is
   scored once.
6. **Escalation only for uncertain jobs**, per the rules above.
7. **Cloud evaluations are cached too**, keyed separately.
8. **A hard per-run cloud budget**, `CLOUD_MAX_REQUESTS_PER_RUN`.

The realistic expectation: a first run over a few hundred jobs makes a handful of
cloud calls; subsequent daily runs make close to zero, because only genuinely new
or changed postings are evaluated at all.

---

## Job sources

Set with `SOURCES_ENABLED` (comma-separated).

| Source      | Status    | Notes                                                                         |
| ----------- | --------- | ----------------------------------------------------------------------------- |
| `mock`      | **Works** | 25 built-in fixture jobs. No network. Default.                                |
| `import`    | **Works** | JSON or CSV file you export yourself.                                         |
| `companies` | **Works** | Config-driven career-page scraping. Verified against a live Greenhouse board. |

All three work. There are no placeholder adapters in this list.

### Why there are no job-board adapters

Earlier versions of this project shipped adapters for two large job boards. Both
have been removed, because neither worked and neither could be made to work
honestly.

The pattern is the same at most large boards. Either the terms of service
prohibit automated access, or the CDN returns 403 to any client that does not
present itself as a mainstream browser, or the listings sit behind
authentication — usually all three. In every case the only route through is to
misrepresent the client or evade an access control, which this project does not
do. Shipping an adapter that returns nothing is worse than shipping no adapter:
it reads as a bug rather than as a decision.

So the boards are not the supported path. **Export or copy the postings yourself
and feed them in:**

```bash
SOURCES_ENABLED=import
IMPORT_FILE=./data/my-jobs.json
```

JSON (an array, or `{ "jobs": [...] }`) and CSV both work. Common header names
are recognised automatically — `company`/`company_name`/`employer`,
`title`/`job_title`/`role`, `url`/`link`/`job_url`, and so on. Anything you can
get out of a board, a spreadsheet or your own notes goes in this way, and every
downstream stage — dedup, filtering, ranking, tracking — treats it identically to
a scraped job.

The other supported path is scraping company career pages directly, which is
covered next. Company boards are generally both permitted and stable, and they
are where the postings originate anyway.

### Career pages — verified working

Driven entirely by `config/sources.yaml`:

```bash
cp config/sources.example.yaml config/sources.yaml
SOURCES_ENABLED=companies
```

The example ships a **tested** Greenhouse entry. Greenhouse's robots.txt permits
crawling and serves honestly-identified clients, which is why it actually runs —
50 real jobs scraped, normalized, and persisted during development. The same
selectors work for any company on `job-boards.greenhouse.io`.

#### Pagination

Most ATSs page at 50 jobs. Without a `pagination` block you get only the first page —
GitLab, for example, has 227 openings and you would see 50 of them.

```yaml
pagination:
  type: query # query -> ?page=2   ·   path -> /page/2
  param: page
  startPage: 1
  maxPages: 10 # ceiling, not a target
```

Paging stops at whichever comes first: an empty page, a short page (the last one), a page
identical to the previous one (the site ignored the parameter), or `maxPages`. Hitting
`maxPages` is logged as a warning so a truncated board is never silent. Each page is
fetched through the robots gate and the normal politeness delay.

Lever renders every job on one page — omit `pagination` there entirely.

For other sites: open the page, inspect it, write selectors that match. An empty
result means your selectors are wrong, not that the company has no openings —
the log says so explicitly.

Every navigation passes the robots gate regardless of what you configure.

---

## Adding a job source

Implement one interface:

```ts
export interface JobSource {
  readonly name: string;
  readonly status: SourceStatus; // SUPPORTED | EXPERIMENTAL | UNSUPPORTED
  readonly notes?: string;
  fetchJobs(options: FetchJobsOptions): Promise<RawJob[]>;
  close?(): Promise<void>;
}
```

Return `RawJob` — loose and source-shaped. Normalization, fingerprinting,
deduplication, filtering and evaluation are handled for you. Then register it in
`src/sources/registry.ts`.

If a source needs a browser, take a `BrowserService` and use it. Do not import
Playwright directly — the robots gate lives in `BrowserService.openPage`, and
bypassing it bypasses the gate.

---

## Scheduling

```bash
# In .env
JOB_RUN_CRON="0 8 * * *"

pnpm jobs:schedule
```

Runs once per day at 08:00 until interrupted. Overlapping runs are skipped rather
than queued. Manual `pnpm jobs:run` always works independently of the scheduler.

For a long-lived schedule, prefer your OS scheduler (`cron`, `launchd`, systemd
timers) invoking `pnpm jobs:run` — it survives reboots, which a foreground
process does not.

**macOS / launchd.** `scripts/run-daily.sh` is the wrapper launchd should call:
launchd does not read your shell profile, so the script locates the project and
your `pnpm` itself, and waits for Ollama to come up if the machine has just
woken. `scripts/com.jobfinder.daily.plist.template` is the job definition, with
the absolute paths left as `__PROJECT_DIR__` because launchd requires them and
they differ per machine:

```bash
sed "s|__PROJECT_DIR__|$PWD|g" scripts/com.jobfinder.daily.plist.template \
  > ~/Library/LaunchAgents/com.jobfinder.daily.plist
launchctl load ~/Library/LaunchAgents/com.jobfinder.daily.plist
```

Output goes to `logs/jobfinder.log`. If `pnpm` lives somewhere unusual, set
`NODE_BIN_DIR` in the plist's environment rather than editing the script.

---

## Testing

```bash
pnpm test
```

279 tests, and the whole suite runs in about a second. No external services and
no downloads: integration tests run against an in-memory SQLite database, and LLM
behaviour is driven through `MockLLMProvider` and `MockJobSource`.

Covered: profile validation, normalization (salary, experience, remote status,
dates, HTML), fingerprinting, all four deduplication strategies, deterministic
filtering, scoring thresholds, escalation rules, malformed-output handling and
retry, batching and batch fallback, caching, CSV/JSON generation and escaping,
robots.txt parsing, secret redaction, cost tracking, persistence and job
history, career-page pagination and its stop conditions, the dashboard HTTP API and
application tracking, and the full pipeline end to end.

The five required escalation scenarios are tested explicitly:

| Scenario                             | Expected                   | Test                |
| ------------------------------------ | -------------------------- | ------------------- |
| confidence 0.95, `needsCloud: false` | no cloud call              | `evaluator.test.ts` |
| confidence 0.62, `needsCloud: true`  | cloud call                 | `evaluator.test.ts` |
| malformed JSON                       | retry local, then escalate | `evaluator.test.ts` |
| job already evaluated, unchanged     | no LLM call                | `evaluator.test.ts` |
| description changed                  | re-evaluate                | `evaluator.test.ts` |

---

## Security

- **No credentials are ever stored.** No passwords, no cookies, no session state.
  The browser context is explicitly ephemeral.
- **Secrets are redacted from all log output** — OpenRouter, OpenAI, Google,
  GitHub token shapes, bearer headers, and credentials embedded in any URL.
  Redaction is applied in the logger itself, so it cannot be forgotten at a call
  site.
- **API keys travel in headers, never in URLs**, so they cannot leak via logs or
  referrers.
- `.env`, `config/profile.yaml` and `config/sources.yaml` are gitignored.
- **robots.txt is enforced, fail-closed.** If the file cannot be read, crawling is
  refused. A robots.txt that returns an HTML challenge page is treated as a
  refusal. `RESPECT_ROBOTS_TXT=false` exists but disables a safety mechanism —
  leave it alone.
- The browser identifies itself honestly and rate-limits between navigations
  (`SCRAPE_DELAY_MS`, default 2500ms).
- **No CAPTCHA solving, no authentication bypass, no anti-bot evasion, no
  detection avoidance.** Where a site refuses automation, the answer is the
  import path, not a workaround.

---

## Limitations

Stated plainly:

- **There is no job-board integration**, for the reasons documented above. The
  supported paths are career-page scraping and the `import` file. If you want
  postings from a large board, you export them yourself.
- **Career-page scraping is only as good as your selectors.** Sites redesign.
  When they do, you get zero results and a warning, not an error — check the log.
- **An 8B local model is slow.** ~5 minutes for 10 jobs, cold. Caching makes
  repeat runs fast, but the first run over hundreds of jobs takes a while. Run it
  on a schedule, not interactively.
- **LLM scores are judgements, not measurements.** Two runs of the same model on
  the same job can differ by a few points. Use the ranking to triage, not to
  decide.
- **Confidence calibration varies by model.** `LLM_CONFIDENCE_THRESHOLD` and
  `LLM_SOFT_FLAG_THRESHOLD` may need tuning when you switch models. Watch the
  escalation counts in the run summary.
- **Cost estimates are only as good as the prices you configure.** The defaults
  are a guess.
- **Salary parsing is heuristic.** LPA, crore, and major currency formats are
  handled; unusual formats are kept as raw text and passed to the model rather
  than guessed at.
- **Deduplication is deliberately conservative.** You will occasionally see two
  rows for the same job. That is the intended trade: a missed duplicate costs one
  CSV row, a wrong merge silently hides a real opening.
- **No embeddings or semantic search.** Title matching is lexical, so an unusual
  job title may be filtered before the model sees it. Widen `targetRoles` or
  lower the similarity threshold if you suspect this.
- **The dashboard is local only.** It runs on this machine, reachable at localhost and
  nowhere else. There is no phone access and no sharing, which is the trade for having no
  authentication and no data leaving the machine.
- **Career-page list views carry little data.** Most boards show only a title, location
  and link — no salary, no experience band, usually no date. The model is told these are
  unknown rather than absent, but it has less to work with than a full posting would give
  it, which shows up as lower confidence and more escalations.
- **Pagination depends on the site keeping its URL scheme.** If a board switches from
  `?page=` to infinite scroll, you get page one and a log line, not an error.

---

## Design decisions

Judgement calls made during implementation, and why:

- **The score is authoritative; the recommendation label is derived from it.**
  Models sometimes return a high score and a contradictory label.
- **Soft uncertainty flags need a quorum to escalate.** Measured: this took
  escalations from 8/10 to 3/10 without degrading results. See
  [escalation](#local--cloud-escalation).
- **Both OpenRouter and Gemini are implemented.** The two key formats are not
  interchangeable, and the pipeline should work with whichever you hold.
- **Missing information never causes a rejection.** Encoded in the filters, the
  schema (`null` = "not stated"), and the prompts.
- **A failed batch retries per job.** One malformed entry should not discard four
  good evaluations.
- **SQLite, not a database server.** This is a single-user tool that holds a few
  thousand rows and is read by one process on one machine. A server would add an
  install step, a service to keep running and a connection string to misconfigure,
  and would buy nothing: the concurrency it exists to manage never occurs here.
  The cost is that the queries are hand-written SQL rather than a document API.
- **Instants are stored as ISO-8601 text, not epoch integers.** ISO-8601 sorts and
  compares lexicographically, so date filters are plain string comparisons, and the
  file stays readable in any SQLite browser.
- **The evaluation cache is keyed on `(contentHash, localModel)`,** not on job id and not
  on the winning model. Keying it on the winning model meant every escalated job missed
  the cache and re-paid for a cloud call on every run; keying on the local model means a
  model change still invalidates prior judgements, as it must.
- **Application tracking lives in its own table.** The pipeline rewrites job rows
  on every scrape; user-authored state must not be reachable by that write.
- **Both local and cloud evaluations are persisted** so disagreements can be
  audited later.
- **`RobotsGate` fails closed and throws** rather than returning a boolean, so it
  cannot be accidentally ignored at a call site.
- **When both local and cloud fail, the result is score 0 / confidence 0** with an
  explicit "review this manually" concern — never an invented number.

---

## Future extensions

The architecture leaves room for, but v1 deliberately does not implement:
embeddings and semantic search, automatic resume selection and tailoring,
browser-assisted application preparation, a human approval workflow, email or
Telegram notifications, a dashboard, and application tracking.
