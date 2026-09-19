import { getJson, postJson } from '../core/api.js';
import { $, escapeHtml, toast } from '../core/dom.js';

/* The stages runPipeline reports, collapsed to the ones worth showing. */
const STAGES = [
  { id: 'fetching', label: 'Fetch' },
  { id: 'filtering', label: 'Filter', also: ['normalizing', 'deduplicating'] },
  { id: 'persisting', label: 'Save' },
  { id: 'evaluating', label: 'Score' },
  { id: 'ranking', label: 'Rank' },
  { id: 'exporting', label: 'Export' },
];

const MAX_LOG_LINES = 2000;

const state = {
  running: false,
  stage: null,
  reached: new Set(),
  failed: false,
  lines: [],
  autoscroll: true,
  pending: [],
  frame: null,
  missed: 0,
  source: null,
  loaded: false,
};

let logEl = null;

/* ── Stages and progress ───────────────────────────────────────────────── */

function stageIndex(id) {
  return STAGES.findIndex((s) => s.id === id || s.also?.includes(id));
}

function renderStages() {
  const current = stageIndex(state.stage);
  $('run-stages').innerHTML = STAGES.map((stage, index) => {
    let mod = 'pending';
    if (state.failed && index === current) mod = 'failed';
    else if (index === current && state.running) mod = 'active';
    else if (state.reached.has(index) || (current > index && current !== -1)) mod = 'done';
    const mark = { done: '✓', active: '›', failed: '✕', pending: '·' }[mod];
    return `<li class="stage stage--${mod}"><span class="stage__mark">${mark}</span>
      ${escapeHtml(stage.label)}</li>`;
  }).join('');
}

function renderProgress(progress) {
  const bar = $('run-progress');
  if (!state.running) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;

  if (progress?.total && progress.current) {
    const percent = Math.round((progress.current / progress.total) * 100);
    bar.classList.remove('progress--indet');
    bar.firstElementChild.style.width = `${percent}%`;
    bar.setAttribute('aria-valuenow', String(percent));
  } else {
    bar.classList.add('progress--indet');
    bar.firstElementChild.style.width = '100%';
    bar.removeAttribute('aria-valuenow');
  }
}

function announce(message) {
  $('run-announce').textContent = message;
}

function setRunning(running) {
  state.running = running;
  $('run-start').disabled = running;
  $('run-cancel').hidden = !running;
  $('run-state').textContent = running ? 'Running…' : '';
  renderProgress(null);
  renderStages();
}

/* ── Log pane ──────────────────────────────────────────────────────────── */

function lineHtml(line) {
  const time = new Date(line.at).toLocaleTimeString();
  const meta = line.meta ? `<span class="logline__meta">${escapeHtml(line.meta)}</span>` : '';
  return `<div class="logline logline--${escapeHtml(line.level)}">
    <span class="logline__t">${escapeHtml(time)}</span>
    <span class="logline__tag">${escapeHtml(line.tag)}</span>
    <span class="logline__msg">${escapeHtml(line.message)}${meta}</span>
  </div>`;
}

/* Batched through requestAnimationFrame: a burst of a hundred lines should
   cost one layout, not a hundred. */
function appendLine(line) {
  state.lines.push(line);
  state.pending.push(line);
  if (state.frame) return;

  state.frame = requestAnimationFrame(() => {
    state.frame = null;
    const chunk = state.pending.splice(0);
    if (chunk.length === 0) return;

    logEl.insertAdjacentHTML('beforeend', chunk.map(lineHtml).join(''));
    while (logEl.childElementCount > MAX_LOG_LINES) logEl.firstElementChild.remove();

    if (state.autoscroll) logEl.scrollTop = logEl.scrollHeight;
    else {
      state.missed += chunk.length;
      const jump = $('log-jump');
      jump.hidden = false;
      jump.textContent = `↓ ${state.missed} new line${state.missed === 1 ? '' : 's'}`;
    }
  });
}

function resetLog() {
  state.lines = [];
  state.pending = [];
  state.missed = 0;
  state.autoscroll = true;
  logEl.innerHTML = '';
  $('log-jump').hidden = true;
}

function jumpToLatest() {
  state.autoscroll = true;
  state.missed = 0;
  $('log-jump').hidden = true;
  logEl.scrollTop = logEl.scrollHeight;
}

/* ── Summary ───────────────────────────────────────────────────────────── */

function tile(number, label) {
  return `<div class="stat"><span class="stat__n">${escapeHtml(number)}</span>
    <span class="stat__l">${escapeHtml(label)}</span></div>`;
}

function breakdown(title, counts) {
  const entries = Object.entries(counts ?? {});
  if (entries.length === 0) return '';
  return `<div class="breakdown"><h4>${escapeHtml(title)}</h4><dl>${entries
    .sort((a, b) => b[1] - a[1])
    .map(([key, n]) => `<dt>${escapeHtml(key.toLowerCase().replace(/_/g, ' '))}</dt><dd>${n}</dd>`)
    .join('')}</dl></div>`;
}

function renderSummary(summary) {
  const host = $('run-summary');
  if (!summary) {
    host.hidden = true;
    return;
  }
  host.hidden = false;

  const { counts, usage } = summary;
  host.innerHTML = `
<h3 class="summary__title">Run finished</h3>

<div class="statgrid">
  ${tile(summary.jobsFetched, 'fetched')}
  ${tile(summary.jobsDeduplicated, 'after duplicates')}
  ${tile(summary.jobsFiltered, 'passed your filters')}
  ${tile(summary.jobsEvaluated, 'scored')}
  ${tile(summary.jobsFromCache, 'reused from cache')}
  ${tile(summary.jobsNew, 'new to you')}
</div>

<div class="recgrid">
  <span class="rec rec--high">${counts.HIGH_PRIORITY} high priority</span>
  <span class="rec rec--apply">${counts.APPLY} apply</span>
  <span class="rec rec--consider">${counts.CONSIDER} consider</span>
  <span class="rec rec--skip">${counts.SKIP} skip</span>
</div>

<p class="summary__cost">
  Local model <b>${escapeHtml(summary.localModel)}</b> in ${summary.batches} batch${
    summary.batches === 1 ? '' : 'es'
  }.
  Cloud: <b>${usage.cloudRequests}</b> request${usage.cloudRequests === 1 ? '' : 's'},
  ${usage.cloudInputTokens + usage.cloudOutputTokens} tokens,
  about <b>$${usage.estimatedCloudCost.toFixed(4)}</b> —
  <a href="#/settings">an estimate, based on the prices in Settings</a>.
</p>

${
  summary.errors.length > 0
    ? `<div class="notice notice--danger"><b>Warnings and errors</b><ul>${summary.errors
        .map((e) => `<li>${escapeHtml(e)}</li>`)
        .join('')}</ul></div>`
    : ''
}

${
  summary.outputFiles.length > 0
    ? `<p class="summary__files">Written: ${summary.outputFiles
        .map((f) => `<code>${escapeHtml(f)}</code>`)
        .join(' ')}</p>`
    : ''
}

<details class="summary__more">
  <summary>What the pipeline actually did</summary>
  <div class="breakdowns">
    ${breakdown('Jobs per source', summary.sourceCounts)}
    ${breakdown('Dropped by rule', summary.filterRuleCounts)}
    ${breakdown('Why jobs went to the cloud', summary.escalationReasonCounts)}
  </div>
</details>

<p><a class="btn btn--primary" href="?newOnly=true&sort=firstSeen#/jobs">View the new jobs</a></p>`;
}

/* ── Event stream ──────────────────────────────────────────────────────── */

function applyState(snapshot) {
  setRunning(snapshot.running);
  if (snapshot.progress) {
    state.stage = snapshot.progress.stage;
    const index = stageIndex(state.stage);
    if (index >= 0) state.reached.add(index);
    renderStages();
    renderProgress(snapshot.progress);
  }
  if (!snapshot.running && snapshot.lastError) {
    $('run-state').textContent = snapshot.lastError;
  }
}

function handleEvent(type, data) {
  switch (type) {
    case 'state':
      applyState(data);
      break;
    case 'progress': {
      state.stage = data.stage;
      const index = stageIndex(data.stage);
      if (index >= 0) state.reached.add(index);
      renderStages();
      renderProgress(data);
      announce(data.message);
      break;
    }
    case 'log':
      appendLine(data);
      break;
    case 'summary':
      state.failed = false;
      renderSummary(data);
      announce('Run finished');
      break;
    case 'error':
      state.failed = true;
      renderStages();
      $('run-state').textContent = data.cancelled ? 'Stopped' : data.message;
      announce(data.cancelled ? 'Run stopped' : `Run failed: ${data.message}`);
      toast(data.cancelled ? 'Run stopped' : 'Run failed');
      break;
    default:
      break;
  }
}

function connect() {
  // EventSource reconnects on its own using the server's retry: interval.
  // Adding a second reconnect loop on top is the classic way to end up with
  // two streams, so this only reports what readyState already tells us.
  const source = new EventSource('/api/runs/stream');
  state.source = source;

  for (const type of ['state', 'progress', 'log', 'summary', 'error']) {
    source.addEventListener(type, (event) => {
      try {
        handleEvent(type, JSON.parse(event.data));
      } catch {
        /* a malformed frame must not kill the stream */
      }
    });
  }

  source.addEventListener('open', () => {
    $('run-connection').hidden = true;
    // Reconcile after any gap: the run may have ended while we were away.
    getJson('/api/runs/current')
      .then(applyState)
      .catch(() => undefined);
  });

  source.onerror = () => {
    const banner = $('run-connection');
    banner.hidden = false;
    if (source.readyState === EventSource.CLOSED) {
      banner.className = 'notice notice--danger';
      banner.innerHTML = `Lost the connection to the server. Is it still running?
        <button class="linkbtn" id="run-reconnect">Try again</button>`;
      $('run-reconnect').addEventListener('click', () => {
        banner.hidden = true;
        connect();
      });
      if (state.running) {
        // Never leave a bar spinning as if work were still happening.
        setRunning(false);
        $('run-state').textContent =
          'Connection lost. The run may or may not have finished — check History.';
      }
    } else {
      banner.className = 'notice notice--warn';
      banner.textContent = 'Reconnecting…';
    }
  };
}

/* ── Starting and stopping ─────────────────────────────────────────────── */

function chosenSources() {
  return [...document.querySelectorAll('[data-run-source]:checked')].map(
    (input) => input.dataset.runSource,
  );
}

async function startRun() {
  resetLog();
  renderSummary(null);
  state.reached.clear();
  state.failed = false;
  $('run-state').textContent = 'Starting…';

  try {
    await postJson('/api/runs', {
      sources: chosenSources(),
      noCloud: $('run-no-cloud').checked,
      dryRun: $('run-dry').checked,
      skipExport: $('run-skip-export').checked,
    });
  } catch (err) {
    // 409 means someone else already started one; adopt it rather than erroring.
    if (err.status === 409) {
      const snapshot = await getJson('/api/runs/current');
      applyState(snapshot);
      toast('A run is already in progress');
      return;
    }
    $('run-state').textContent = err.message;
    toast(err.message);
  }
}

async function cancelRun() {
  $('run-state').textContent = 'Stopping after the current batch…';
  try {
    await postJson('/api/runs/cancel');
  } catch {
    /* it may have finished on its own between click and request */
  }
}

/* ── View ──────────────────────────────────────────────────────────────── */

export const runView = {
  name: 'run',

  mount() {
    logEl = $('run-log');

    $('run-start').addEventListener('click', startRun);
    $('run-cancel').addEventListener('click', cancelRun);
    $('log-jump').addEventListener('click', jumpToLatest);
    $('log-copy').addEventListener('click', async () => {
      const text = state.lines
        .map((l) => `${l.at} [${l.tag}] ${l.message}${l.meta ? ` ${l.meta}` : ''}`)
        .join('\n');
      try {
        await navigator.clipboard.writeText(text);
        toast('Log copied');
      } catch {
        toast('Could not copy — your browser blocked it');
      }
    });

    $('log-errors-only').addEventListener('change', (event) => {
      logEl.classList.toggle('logpane--errors-only', event.target.checked);
    });

    logEl.addEventListener('scroll', () => {
      const atBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 24;
      state.autoscroll = atBottom;
      if (atBottom) {
        state.missed = 0;
        $('log-jump').hidden = true;
      }
    });

    renderStages();
  },

  /** Opened at boot, not on entering the view, so a run keeps streaming. */
  async boot() {
    try {
      const snapshot = await getJson('/api/runs/current');
      applyState(snapshot);
      for (const event of (await getJson('/api/runs/events')).events) {
        handleEvent(event.type, event.data);
      }
      if (snapshot.lastSummary) renderSummary(snapshot.lastSummary);
    } catch {
      /* the stream will report the problem */
    }
    connect();
  },

  show() {
    state.loaded = true;
  },

  refresh() {
    getJson('/api/runs/current')
      .then(applyState)
      .catch(() => undefined);
  },

  onSubmitKey(event) {
    event.preventDefault();
    if (!state.running) startRun();
  },

  onKey(event) {
    if (event.key === 'End') jumpToLatest();
  },
};
