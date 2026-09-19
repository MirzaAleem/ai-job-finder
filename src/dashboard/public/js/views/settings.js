import { getJson, postJson, putJson } from '../core/api.js';
import { $, escapeHtml, toast } from '../core/dom.js';
import { confirmLeave } from '../core/leave.js';
import { createForm } from '../forms/form.js';

const state = { snapshot: null, form: null, loaded: false };

/** The server sends everything as strings; the form wants real types. */
function typedValues(fields, raw) {
  const values = {};
  for (const field of fields) {
    const text = raw[field.key]?.value ?? '';
    if (field.type === 'boolean') values[field.key] = text === 'true';
    else if (field.type === 'number') values[field.key] = text === '' ? '' : Number(text);
    else values[field.key] = text;
  }
  return values;
}

function asStrings(values) {
  const out = {};
  for (const [key, value] of Object.entries(values)) {
    out[key] = value === undefined || value === null ? '' : String(value);
  }
  return out;
}

/** Fields another view owns are displayed but never submitted. */
function writable(fields, values) {
  const owned = new Set(fields.filter((f) => f.managedBy).map((f) => f.key));
  const out = {};
  for (const [key, value] of Object.entries(values)) {
    if (!owned.has(key)) out[key] = value;
  }
  return out;
}

function renderBands(values) {
  const host = $('score-bands');
  if (!host) return;

  const high = Number(values.SCORE_HIGH_PRIORITY);
  const apply = Number(values.SCORE_APPLY);
  const consider = Number(values.SCORE_CONSIDER);
  if ([high, apply, consider].some((n) => !Number.isFinite(n))) return;

  const ordered = high >= apply && apply >= consider;
  const bands = [
    { label: 'Skip', from: 0, to: consider, tone: 'skip' },
    { label: 'Consider', from: consider, to: apply, tone: 'consider' },
    { label: 'Apply', from: apply, to: high, tone: 'apply' },
    { label: 'High priority', from: high, to: 100, tone: 'high' },
  ];

  host.innerHTML = `
    <div class="bands" role="img" aria-label="How scores map to recommendations">
      ${bands
        .map((band) => {
          const width = Math.max(0, band.to - band.from);
          return `<div class="band band--${band.tone}" style="flex:${width} 0 0">
            <span class="band__label">${escapeHtml(band.label)}</span>
            <span class="band__range">${band.from}–${band.to}</span>
          </div>`;
        })
        .join('')}
    </div>
    ${
      ordered
        ? ''
        : `<p class="notice notice--warn">These need to descend:
             high priority ≥ apply ≥ consider. As they stand, some bands are empty.</p>`
    }`;
}

async function loadModels() {
  const host = $('settings-models');
  if (!host) return;
  host.innerHTML = '<span class="muted">Checking Ollama…</span>';

  try {
    const { models, error } = await getJson('/api/models');
    if (error || models.length === 0) {
      host.innerHTML = `<span class="muted">${escapeHtml(
        error ?? 'No models installed. Pull one with: ollama pull llama3.1:8b',
      )}</span>`;
      return;
    }
    host.innerHTML = `<span class="muted">Installed:</span> ${models
      .map(
        (m) =>
          `<button type="button" class="chip chip--action" data-model="${escapeHtml(m.name)}">
             ${escapeHtml(m.name)}</button>`,
      )
      .join('')}`;
  } catch (err) {
    host.innerHTML = `<span class="muted">${escapeHtml(err.message)}</span>`;
  }
}

async function probeProviders() {
  const host = $('settings-probe');
  if (!host) return;
  host.innerHTML = '<span class="muted">Checking…</span>';

  try {
    const { local, cloud } = await postJson('/api/settings/test-providers');
    host.innerHTML = [
      `<span class="probe probe--${local.ok ? 'ok' : 'bad'}">Local model: ${escapeHtml(
        local.message,
      )}</span>`,
      `<span class="probe probe--${cloud.ok ? 'ok' : 'bad'}">Cloud: ${escapeHtml(
        cloud.message,
      )}</span>`,
    ].join('');
  } catch (err) {
    host.innerHTML = `<span class="probe probe--bad">${escapeHtml(err.message)}</span>`;
  }
}

function renderRestartBanner(pending) {
  const host = $('settings-restart');
  if (!host) return;
  if (!pending?.length) {
    host.hidden = true;
    return;
  }
  host.hidden = false;
  host.innerHTML = `<p class="notice notice--warn">Saved, but the dashboard is still using the
    old value for <b>${pending.map(escapeHtml).join(', ')}</b>. Restart it to pick these up.</p>`;
}

async function load() {
  const snapshot = await getJson('/api/settings');
  state.snapshot = snapshot;
  state.form.load({
    groups: snapshot.groups,
    fields: snapshot.fields,
    values: typedValues(snapshot.fields, snapshot.values),
    meta: snapshot.values,
  });
  renderRestartBanner(snapshot.restartPending);
  state.loaded = true;
}

export const settingsView = {
  name: 'settings',

  mount() {
    state.form = createForm({
      root: $('settings-form'),
      bar: $('settings-bar'),
      afterRender: renderBands,
      onEdit: renderBands,
      save: async (values) => {
        const result = await putJson('/api/settings', {
          values: asStrings(writable(state.snapshot.fields, values)),
        });
        state.snapshot = result;
        renderRestartBanner(result.restartPending);
        toast('Settings saved');
        return result;
      },
    });

    $('settings-bar')
      .querySelector('[data-action="save"]')
      .addEventListener('click', () => state.form.save());
    $('settings-bar')
      .querySelector('[data-action="revert"]')
      .addEventListener('click', () => state.form.revert());
    $('settings-probe-btn')?.addEventListener('click', probeProviders);

    // Clicking an installed model fills the field rather than making you type it.
    $('settings-models')?.addEventListener('click', (event) => {
      const button = event.target.closest('[data-model]');
      if (!button) return;
      const input = $('f-OLLAMA_MODEL');
      if (!input) return;
      input.value = button.dataset.model;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  },

  async show() {
    if (!state.loaded) {
      await load();
      loadModels();
    }
  },

  refresh() {
    load();
    loadModels();
  },

  onSubmitKey(event) {
    event.preventDefault();
    state.form?.save();
  },

  beforeLeave: () => confirmLeave(state.form),

  isDirty: () => Boolean(state.form?.isDirty()),
};
