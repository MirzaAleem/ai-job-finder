import { getJson } from '../core/api.js';
import { $, escapeHtml, relativeDate } from '../core/dom.js';

const state = { runs: [], total: 0, offset: 0, expanded: new Set(), details: new Map() };
const PAGE = 20;

function duration(ms) {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return '<1s';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}

function statusTag(run) {
  if (run.interrupted) {
    return '<span class="tag tag--degraded" title="Left behind by a process that was killed">interrupted</span>';
  }
  const tone = { COMPLETED: 'new', FAILED: 'degraded', RUNNING: 'cloud' }[run.status] ?? 'new';
  return `<span class="tag tag--${tone}">${escapeHtml(run.status.toLowerCase())}</span>`;
}

function renderDetail(run) {
  const detail = state.details.get(run.id);
  if (!detail) return '<tr class="runrow__detail"><td colspan="9">Loading…</td></tr>';

  const list = (title, counts) => {
    const entries = Object.entries(counts ?? {});
    if (entries.length === 0) return '';
    return `<div class="breakdown"><h4>${escapeHtml(title)}</h4><dl>${entries
      .sort((a, b) => b[1] - a[1])
      .map(
        ([key, n]) => `<dt>${escapeHtml(key.toLowerCase().replace(/_/g, ' '))}</dt><dd>${n}</dd>`,
      )
      .join('')}</dl></div>`;
  };

  return `<tr class="runrow__detail"><td colspan="9">
    <div class="breakdowns">
      ${list('Jobs per source', detail.sourceCounts)}
      ${list('Why jobs went to the cloud', detail.escalationReasonCounts)}
      <div class="breakdown"><h4>Tokens</h4><dl>
        <dt>local requests</dt><dd>${detail.localRequests}</dd>
        <dt>cloud in</dt><dd>${detail.cloudInputTokens}</dd>
        <dt>cloud out</dt><dd>${detail.cloudOutputTokens}</dd>
      </dl></div>
    </div>
    ${
      detail.errors.length > 0
        ? `<div class="notice notice--danger"><b>Errors</b><ul>${detail.errors
            .map((e) => `<li>${escapeHtml(e)}</li>`)
            .join('')}</ul></div>`
        : ''
    }
    ${
      detail.outputFiles.length > 0
        ? `<p class="summary__files">Exported: ${detail.outputFiles
            .map((f) => `<code>${escapeHtml(f)}</code>`)
            .join(' ')}</p>`
        : '<p class="muted">No files were exported for this run.</p>'
    }
  </td></tr>`;
}

function render() {
  const host = $('history-body');

  if (state.runs.length === 0) {
    $('history-table').hidden = true;
    $('history-empty').hidden = false;
    return;
  }
  $('history-table').hidden = false;
  $('history-empty').hidden = true;

  host.innerHTML = state.runs
    .map((run) => {
      const row = `
<tr class="runrow" data-id="${escapeHtml(run.id)}">
  <td>${escapeHtml(relativeDate(run.startedAt))}</td>
  <td>${escapeHtml(duration(run.durationMs))}</td>
  <td>${statusTag(run)}</td>
  <td class="num">${run.jobsFetched}</td>
  <td class="num">${run.jobsEvaluated}</td>
  <td class="num">${run.jobsNew}</td>
  <td class="num">${run.counts.HIGH_PRIORITY + run.counts.APPLY}</td>
  <td class="num">${run.cloudRequests}</td>
  <td class="num">$${run.estimatedCloudCost.toFixed(4)}</td>
</tr>`;
      return state.expanded.has(run.id) ? row + renderDetail(run) : row;
    })
    .join('');

  $('history-more').hidden = state.runs.length >= state.total;
  $('history-count').textContent = `${state.runs.length} of ${state.total}`;
}

async function load({ append = false } = {}) {
  const offset = append ? state.runs.length : 0;
  const body = await getJson(`/api/runs?limit=${PAGE}&offset=${offset}`);
  state.runs = append ? [...state.runs, ...body.runs] : body.runs;
  state.total = body.total;
  render();
}

async function toggle(id) {
  if (state.expanded.has(id)) {
    state.expanded.delete(id);
    render();
    return;
  }
  state.expanded.add(id);
  render();

  if (!state.details.has(id)) {
    try {
      const { run } = await getJson(`/api/runs/${id}`);
      state.details.set(id, run);
    } catch {
      state.expanded.delete(id);
    }
    render();
  }
}

export const historyView = {
  name: 'history',

  mount() {
    $('history-body').addEventListener('click', (event) => {
      const row = event.target.closest('.runrow');
      if (row) toggle(row.dataset.id);
    });
    $('history-more').addEventListener('click', () => load({ append: true }));
  },

  show() {
    if (state.runs.length === 0) load();
    else render();
  },

  refresh: () => load(),

  onKey(event) {
    if (event.key !== 'Enter') return;
    const first = $('history-body').querySelector('.runrow');
    if (first) toggle(first.dataset.id);
  },
};
