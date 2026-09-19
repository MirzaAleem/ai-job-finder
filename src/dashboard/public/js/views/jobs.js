import { getJson, patchJson } from '../core/api.js';
import { $, debounce, escapeHtml, relativeDate, toast } from '../core/dom.js';
import { navigate } from '../core/router.js';

const STATUSES = ['NEW', 'INTERESTED', 'APPLIED', 'INTERVIEWING', 'REJECTED', 'OFFER', 'DISMISSED'];

const STATUS_LABELS = {
  NEW: 'New',
  INTERESTED: 'Interested',
  APPLIED: 'Applied',
  INTERVIEWING: 'Interviewing',
  REJECTED: 'Rejected',
  OFFER: 'Offer',
  DISMISSED: 'Dismissed',
};

const state = {
  jobs: [],
  stats: null,
  activeIndex: -1,
  expanded: new Set(),
  loading: false,
};

let listEl = null;

/* ── Filter state in the URL ───────────────────────────────────────────── */

function readFilters() {
  const params = new URLSearchParams(location.search);
  return {
    search: params.get('search') ?? '',
    recommendation: params.get('recommendation') ?? '',
    company: params.get('company') ?? '',
    minScore: params.get('minScore') ?? '0',
    sort: params.get('sort') ?? 'score',
    status: params.get('status') ?? '',
    newOnly: params.get('newOnly') === 'true',
    includeClosed: params.get('includeClosed') === 'true',
  };
}

function writeFilters(filters) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value === '' || value === false || value === '0') continue;
    params.set(key, String(value));
  }
  const query = params.toString();
  // The hash carries the current view. Dropping it here would bounce the user
  // back to the default view the moment they touched a filter.
  history.replaceState(null, '', `${location.pathname}${query ? `?${query}` : ''}${location.hash}`);
}

function syncControlsFromUrl() {
  const f = readFilters();
  $('f-search').value = f.search;
  $('f-recommendation').value = f.recommendation;
  $('f-company').value = f.company;
  $('f-score').value = f.minScore;
  $('f-score-out').textContent = f.minScore;
  $('f-sort').value = f.sort;
  $('f-new').checked = f.newOnly;
  $('f-closed').checked = f.includeClosed;
}

function filtersFromControls() {
  return {
    search: $('f-search').value.trim(),
    recommendation: $('f-recommendation').value,
    company: $('f-company').value,
    minScore: $('f-score').value,
    sort: $('f-sort').value,
    newOnly: $('f-new').checked,
    includeClosed: $('f-closed').checked,
    status: readFilters().status,
  };
}

/* ── Data ──────────────────────────────────────────────────────────────── */

async function load() {
  if (state.loading) return;
  state.loading = true;
  listEl.setAttribute('aria-busy', 'true');

  const params = new URLSearchParams();
  const filters = readFilters();
  if (filters.search) params.set('search', filters.search);
  if (filters.recommendation) params.set('recommendation', filters.recommendation);
  if (filters.company) params.set('company', filters.company);
  if (filters.minScore !== '0') params.set('minScore', filters.minScore);
  if (filters.sort) params.set('sort', filters.sort);
  if (filters.status) params.set('status', filters.status);
  if (filters.newOnly) params.set('newOnly', 'true');
  if (filters.includeClosed) params.set('includeClosed', 'true');

  try {
    const [jobs, stats] = await Promise.all([
      getJson(`/api/jobs?${params.toString()}`),
      getJson('/api/stats'),
    ]);
    state.jobs = jobs.jobs;
    state.stats = stats;
    state.activeIndex = state.jobs.length > 0 ? 0 : -1;
  } catch (err) {
    listEl.innerHTML = `<div class="empty"><h3>Could not load jobs</h3>
      <p>${escapeHtml(err.message)}</p></div>`;
    return;
  } finally {
    state.loading = false;
    listEl.removeAttribute('aria-busy');
  }

  renderRunInfo();
  renderPills();
  renderCompanies();
  render();
}

const updateApplication = (jobId, update) => patchJson(`/api/jobs/${jobId}/application`, update);

/* ── Rendering ─────────────────────────────────────────────────────────── */

function renderRunInfo() {
  const s = state.stats;
  if (!s) return;
  const run = s.lastRun;
  const parts = [
    `<span><b>${s.total}</b> jobs tracked</span>`,
    `<span><b>${s.newToday}</b> new today</span>`,
  ];
  if (run) {
    parts.push(`<span>last run <b>${relativeDate(run.startedAt)}</b></span>`);
    parts.push(
      `<span>cloud <b>${run.cloudRequests}</b> · <b>$${run.estimatedCloudCost.toFixed(4)}</b></span>`,
    );
    if (run.status === 'FAILED') {
      parts.push('<span class="tag tag--degraded">last run failed</span>');
    }
  }
  $('runinfo').innerHTML = parts.join('');
}

function renderPills() {
  const counts = state.stats?.byStatus ?? {};
  const active = readFilters().status;

  const pills = [
    `<button class="pill" data-status="" aria-pressed="${active === ''}">All open</button>`,
    ...STATUSES.map(
      (status) => `<button class="pill" data-status="${status}" aria-pressed="${active === status}">
        ${STATUS_LABELS[status]}<span class="pill__n">${counts[status] ?? 0}</span></button>`,
    ),
  ];
  $('status-pills').innerHTML = pills.join('');
}

function renderCompanies() {
  const select = $('f-company');
  const current = select.value;
  const companies = state.stats?.companies ?? [];
  select.innerHTML =
    '<option value="">Any</option>' +
    companies.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
  select.value = current;
}

function render() {
  $('resultcount').textContent = `${state.jobs.length} shown`;

  if (state.jobs.length === 0) {
    const hasAnyJobs = (state.stats?.total ?? 0) > 0;
    listEl.innerHTML = hasAnyJobs
      ? `<div class="empty"><h3>No jobs match these filters</h3>
           <p>Try clearing the search or lowering the minimum score.</p></div>`
      : `<div class="empty"><h3>No jobs yet</h3>
           <p>Set up your profile, pick your sources, then start a run.</p>
           <p><a class="btn btn--primary" href="#/profile">Set up your profile</a></p></div>`;
    return;
  }

  listEl.innerHTML = state.jobs.map((job, index) => renderJob(job, index)).join('');
}

function renderJob(job, index) {
  const rec = job.recommendation ?? 'none';
  const isExpanded = state.expanded.has(job.id);
  const isClosed = job.status === 'DISMISSED' || job.status === 'REJECTED';

  const tags = [];
  if (job.isNew) tags.push('<span class="tag tag--new">New</span>');
  if (job.escalated) tags.push('<span class="tag tag--cloud">Cloud</span>');
  if (job.degraded) tags.push('<span class="tag tag--degraded">Unverified</span>');

  const meta = [
    job.location && `<span>${escapeHtml(job.location)}</span>`,
    job.remote && `<span>${escapeHtml(job.remote.toLowerCase())}</span>`,
    job.salary && `<span>${escapeHtml(job.salary)}</span>`,
    job.experienceRequired && `<span>${escapeHtml(job.experienceRequired)}</span>`,
    // Most board list pages carry no date; printing "posted unknown" on every
    // row is noise, so the field simply does not appear when it is unknown.
    job.postedAt && `<span>posted ${relativeDate(job.postedAt)}</span>`,
    `<span>${escapeHtml(job.source)}</span>`,
  ]
    .filter(Boolean)
    .join('');

  return `
<article class="job ${index === state.activeIndex ? 'job--active' : ''} ${isClosed ? 'job--closed' : ''}"
         data-id="${job.id}" data-index="${index}">
  <div class="job__head" data-action="toggle">
    <div class="score score--${rec}">
      <span class="score__n">${job.score ?? '—'}</span>
      ${job.confidence !== null ? `<span class="score__c">${Math.round(job.confidence * 100)}%</span>` : ''}
    </div>
    <div class="job__main">
      <h3 class="job__title">${escapeHtml(job.title)}</h3>
      <div class="job__company">${escapeHtml(job.company)}</div>
      <div class="job__meta">${meta}</div>
      ${tags.length ? `<div class="tags" style="margin-top:6px">${tags.join('')}</div>` : ''}
    </div>
    <div class="job__right">
      <select class="statussel" data-action="status" data-status="${job.status}"
              aria-label="Application status">
        ${STATUSES.map(
          (s) =>
            `<option value="${s}" ${s === job.status ? 'selected' : ''}>${STATUS_LABELS[s]}</option>`,
        ).join('')}
      </select>
      <a class="btn btn--primary" href="${escapeHtml(job.applicationUrl)}"
         target="_blank" rel="noopener noreferrer" data-action="open">Apply ↗</a>
    </div>
  </div>
  ${isExpanded ? renderDetail(job) : ''}
</article>`;
}

function renderDetail(job) {
  const section = (heading, inner) => (inner ? `<div><h4>${heading}</h4>${inner}</div>` : '');

  const skills = (items, modifier) =>
    items.length
      ? `<div class="skills">${items
          .map((s) => `<span class="skill ${modifier}">${escapeHtml(s)}</span>`)
          .join('')}</div>`
      : '';

  const bullets = (items) =>
    items.length ? `<ul>${items.map((r) => `<li>${escapeHtml(r)}</li>`).join('')}</ul>` : '';

  return `
<div class="job__body">
  <div class="detail">
    ${section('Matching skills', skills(job.matchingSkills, ''))}
    ${section('Missing skills', skills(job.missingSkills, 'skill--missing'))}
    ${section('Why', bullets(job.reasons))}
    ${section('Concerns', bullets(job.concerns))}
  </div>
  ${
    job.degraded
      ? `<p class="notes__state" style="color:var(--danger)">
           The local model was uncertain and no cloud check ran — treat this score as provisional.
         </p>`
      : ''
  }
  <div class="notes">
    <h4 style="margin:0 0 6px;font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--ink-3)">Notes</h4>
    <textarea data-action="notes" placeholder="Recruiter name, referral, follow-up date…">${escapeHtml(job.notes)}</textarea>
    <div class="notes__state" data-role="notes-state"></div>
  </div>
</div>`;
}

/* ── Interaction ───────────────────────────────────────────────────────── */

function jobElement(index) {
  return listEl.querySelector(`.job[data-index="${index}"]`);
}

function setActive(index) {
  if (state.jobs.length === 0) return;
  const next = Math.max(0, Math.min(index, state.jobs.length - 1));
  const previous = jobElement(state.activeIndex);
  if (previous) previous.classList.remove('job--active');
  state.activeIndex = next;
  const element = jobElement(next);
  if (element) {
    element.classList.add('job--active');
    element.scrollIntoView({ block: 'nearest' });
  }
}

function toggleExpanded(id) {
  if (state.expanded.has(id)) state.expanded.delete(id);
  else state.expanded.add(id);
  render();
}

async function setStatus(jobId, status) {
  const job = state.jobs.find((j) => j.id === jobId);
  if (!job) return;
  const previous = job.status;
  job.status = status;

  try {
    await updateApplication(jobId, { status });
    toast(`${job.title} → ${STATUS_LABELS[status]}`);
    // A job moved out of the visible set should disappear, not linger.
    const hidden = (status === 'DISMISSED' || status === 'REJECTED') && !$('f-closed').checked;
    if (hidden) {
      const index = state.jobs.indexOf(job);
      state.jobs.splice(index, 1);
      state.expanded.delete(jobId);
      if (state.activeIndex >= state.jobs.length) state.activeIndex = state.jobs.length - 1;
    }
    if (state.stats) {
      state.stats.byStatus[previous] = Math.max(0, (state.stats.byStatus[previous] ?? 1) - 1);
      state.stats.byStatus[status] = (state.stats.byStatus[status] ?? 0) + 1;
      renderPills();
    }
    render();
  } catch {
    job.status = previous;
    toast('Could not save — is the server still running?');
    render();
  }
}

const saveNotes = debounce(async (jobId, notes, stateEl) => {
  try {
    await updateApplication(jobId, { notes });
    if (stateEl) stateEl.textContent = 'Saved';
  } catch {
    if (stateEl) stateEl.textContent = 'Could not save';
  }
}, 600);

function applyFilters() {
  writeFilters(filtersFromControls());
  load();
}

const applyFiltersDebounced = debounce(applyFilters, 300);

/* ── View ──────────────────────────────────────────────────────────────── */

export const jobsView = {
  name: 'jobs',

  mount() {
    listEl = $('list');

    listEl.addEventListener('click', (event) => {
      const article = event.target.closest('.job');
      if (!article) return;

      if (event.target.closest('[data-action="open"]')) {
        setActive(Number(article.dataset.index));
        return;
      }
      if (event.target.closest('.statussel')) return;

      if (event.target.closest('[data-action="toggle"]')) {
        setActive(Number(article.dataset.index));
        toggleExpanded(article.dataset.id);
      }
    });

    listEl.addEventListener('change', (event) => {
      const select = event.target.closest('[data-action="status"]');
      if (!select) return;
      setStatus(select.closest('.job').dataset.id, select.value);
    });

    listEl.addEventListener('input', (event) => {
      const textarea = event.target.closest('[data-action="notes"]');
      if (!textarea) return;
      const article = textarea.closest('.job');
      const stateEl = article.querySelector('[data-role="notes-state"]');
      if (stateEl) stateEl.textContent = 'Saving…';

      const job = state.jobs.find((j) => j.id === article.dataset.id);
      if (job) job.notes = textarea.value;
      saveNotes(article.dataset.id, textarea.value, stateEl);
    });

    $('f-search').addEventListener('input', applyFiltersDebounced);
    for (const id of ['f-recommendation', 'f-company', 'f-sort', 'f-new', 'f-closed']) {
      $(id).addEventListener('change', applyFilters);
    }
    $('f-score').addEventListener('input', () => {
      $('f-score-out').textContent = $('f-score').value;
    });
    $('f-score').addEventListener('change', applyFilters);

    $('clear-btn').addEventListener('click', () => {
      history.replaceState(null, '', `${location.pathname}${location.hash}`);
      syncControlsFromUrl();
      load();
    });

    $('status-pills').addEventListener('click', (event) => {
      const pill = event.target.closest('.pill');
      if (!pill) return;
      const filters = filtersFromControls();
      filters.status = pill.dataset.status;
      writeFilters(filters);
      load();
    });

    syncControlsFromUrl();
  },

  show() {
    // Re-render what is already loaded first, then revalidate, so coming back
    // to this tab never blanks the list or loses the selected row.
    if (state.stats) render();
    load();
  },

  refresh: load,

  onKey(event) {
    const active = state.jobs[state.activeIndex];

    switch (event.key) {
      case 'j':
      case 'ArrowDown':
        event.preventDefault();
        setActive(state.activeIndex + 1);
        break;
      case 'k':
      case 'ArrowUp':
        event.preventDefault();
        setActive(state.activeIndex - 1);
        break;
      case 'Enter':
        if (active) {
          event.preventDefault();
          toggleExpanded(active.id);
        }
        break;
      case 'o':
        if (active) window.open(active.applicationUrl, '_blank', 'noopener');
        break;
      case 'a':
        if (active) setStatus(active.id, 'APPLIED');
        break;
      case 'i':
        if (active) setStatus(active.id, 'INTERESTED');
        break;
      case 'x':
        if (active) setStatus(active.id, 'DISMISSED');
        break;
      case 'u':
        if (active) setStatus(active.id, 'NEW');
        break;
      case '/':
        event.preventDefault();
        $('f-search').focus();
        break;
      case 'p':
        navigate('profile');
        break;
      default:
        break;
    }
  },
};
