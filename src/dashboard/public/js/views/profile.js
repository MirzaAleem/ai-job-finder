import { getJson, putJson } from '../core/api.js';
import { $, escapeHtml, toast } from '../core/dom.js';
import { confirmLeave } from '../core/leave.js';
import { createForm } from '../forms/form.js';
import { PROFILE_FIELDS, PROFILE_GROUPS } from '../descriptors/profile.fields.js';

const state = { form: null, loaded: false, payload: null, mode: 'form' };

function renderStatus(payload) {
  const host = $('profile-status');
  if (!host) return;

  if (!payload.exists) {
    host.hidden = false;
    host.innerHTML = `<p class="notice notice--info">You do not have a profile yet. The form below
      is filled in from the bundled example — edit it and save to create
      <code>${escapeHtml(payload.path)}</code>.</p>`;
    return;
  }

  if (payload.profile === null) {
    host.hidden = false;
    host.innerHTML = `<p class="notice notice--danger"><b>This profile has a problem:</b>
      ${escapeHtml(payload.error ?? 'it does not match the expected shape')}.
      Runs will fail until it is fixed. Use the YAML tab to repair it directly.</p>`;
    return;
  }

  host.hidden = true;
}

function toFormValues(profile) {
  // A missing optional must reach the form as empty, not as the string
  // "undefined", and every list needs an array to render into.
  const base = {
    targetRoles: [],
    preferredLocations: [],
    remotePreference: 'ANY',
    yearsOfExperience: '',
    maximumExperienceAccepted: '',
    salary: { currency: 'INR', minimum: '', preferred: '' },
    requiredSkills: [],
    preferredSkills: [],
    excludedRoles: [],
    excludedIndustries: [],
    excludedKeywords: [],
    education: '',
    workAuthorization: '',
    noticePeriod: '',
    additionalPreferences: [],
  };
  return {
    ...base,
    ...(profile ?? {}),
    salary: { ...base.salary, ...(profile?.salary ?? {}) },
  };
}

/** Drop empty optionals so a .strict() schema does not see "" where it wants a number. */
function toProfile(values) {
  const out = {};
  for (const [key, value] of Object.entries(values)) {
    if (key === 'salary') continue;
    if (value === '' || value === undefined || value === null) continue;
    out[key] = value;
  }

  const salary = {};
  if (values.salary?.currency) salary.currency = values.salary.currency;
  if (values.salary?.minimum !== '' && values.salary?.minimum !== undefined) {
    salary.minimum = values.salary.minimum;
  }
  if (values.salary?.preferred !== '' && values.salary?.preferred !== undefined) {
    salary.preferred = values.salary.preferred;
  }
  if (Object.keys(salary).length > 0) out.salary = salary;

  return out;
}

async function load() {
  const payload = await getJson('/api/profile');
  state.payload = payload;

  const source = payload.profile ?? payload.example?.profile ?? null;
  state.form.load({
    groups: PROFILE_GROUPS,
    fields: PROFILE_FIELDS,
    values: toFormValues(source),
  });

  const yamlBox = $('profile-yaml');
  if (yamlBox) yamlBox.value = payload.yaml ?? payload.example?.yaml ?? '';

  renderStatus(payload);
  state.loaded = true;
}

function setMode(mode) {
  state.mode = mode;
  $('profile-form-pane').hidden = mode !== 'form';
  $('profile-yaml-pane').hidden = mode !== 'yaml';
  for (const button of document.querySelectorAll('[data-profile-mode]')) {
    button.setAttribute('aria-pressed', String(button.dataset.profileMode === mode));
  }
}

async function saveYaml() {
  const yaml = $('profile-yaml').value;
  const errorEl = $('profile-yaml-error');
  errorEl.hidden = true;

  try {
    const result = await putJson('/api/profile/raw', { yaml });
    state.payload = result;
    toast('Profile saved');
    // The form is now stale, so rebuild it from what was actually written.
    state.form.load({
      groups: PROFILE_GROUPS,
      fields: PROFILE_FIELDS,
      values: toFormValues(result.profile),
    });
    renderStatus(result);
  } catch (err) {
    errorEl.hidden = false;
    errorEl.textContent = [err.message, ...(err.issues ?? [])].join(' · ');
  }
}

export const profileView = {
  name: 'profile',

  mount() {
    state.form = createForm({
      root: $('profile-form'),
      bar: $('profile-bar'),
      save: async (values) => {
        const result = await putJson('/api/profile', { profile: toProfile(values) });
        state.payload = result;
        $('profile-yaml').value = result.yaml;
        renderStatus(result);
        toast('Profile saved');
        return result;
      },
    });

    $('profile-bar')
      .querySelector('[data-action="save"]')
      .addEventListener('click', () => state.form.save());
    $('profile-bar')
      .querySelector('[data-action="revert"]')
      .addEventListener('click', () => state.form.revert());

    for (const button of document.querySelectorAll('[data-profile-mode]')) {
      button.addEventListener('click', () => setMode(button.dataset.profileMode));
    }
    $('profile-yaml-save')?.addEventListener('click', saveYaml);
    setMode('form');
  },

  async show() {
    if (!state.loaded) await load();
  },

  refresh: load,

  onSubmitKey(event) {
    event.preventDefault();
    if (state.mode === 'yaml') saveYaml();
    else state.form?.save();
  },

  beforeLeave: () => confirmLeave(state.form),

  isDirty: () => Boolean(state.form?.isDirty()),
};
