import { debounce, escapeHtml, getPath, setPath, toast } from '../core/dom.js';
import { attachChips } from './chips.js';
import { clearFieldErrors, readField, renderField, showFieldError } from './field.js';

/**
 * A form controller over a list of field descriptors.
 *
 * The whole form is rendered once from template literals, in the same style as
 * the job list. Keystrokes then mutate the value object and toggle classes
 * directly — re-rendering on every keystroke would destroy the caret position.
 */
export function createForm(options) {
  const { root, save } = options;

  let groups = [];
  let fields = [];
  let meta = {};
  let initial = {};
  let values = {};
  let dirty = false;
  const chipCommits = [];

  const clone = (value) => JSON.parse(JSON.stringify(value ?? {}));

  function fieldsOf(group) {
    return fields.filter((field) => field.group === group.id && visible(field));
  }

  function visible(field) {
    return field.dependsOn ? field.dependsOn(values) : true;
  }

  function render() {
    chipCommits.length = 0;

    root.innerHTML = groups
      .map((group) => {
        const body = fieldsOf(group)
          .map((field) => renderField(field, getPath(values, field.key), meta[field.key] ?? {}))
          .join('');
        if (!body) return '';
        return `
<fieldset class="fs ${group.advanced ? 'fs--advanced' : ''}" data-group="${escapeHtml(group.id)}">
  <legend class="fs__legend">${escapeHtml(group.title)}</legend>
  ${group.blurb ? `<p class="fs__blurb">${escapeHtml(group.blurb)}</p>` : ''}
  <div class="fs__fields">${body}</div>
</fieldset>`;
      })
      .join('');

    for (const field of fields) {
      if (field.type !== 'list' || !visible(field)) continue;
      const host = root.querySelector(`.chips[data-chips="${CSS.escape(field.key)}"]`);
      if (!host) continue;
      chipCommits.push(
        attachChips(
          host,
          () => getPath(values, field.key) ?? [],
          (next) => {
            setPath(values, field.key, next);
            rerenderField(field);
            markDirty();
          },
          toast,
        ),
      );
    }

    options.afterRender?.(values, root);
    updateBar();
  }

  /** Re-render one field in place, for chips where the markup must change. */
  function rerenderField(field) {
    const wrapper = root.querySelector(`.ff[data-key="${CSS.escape(field.key)}"]`);
    if (!wrapper) return;
    const replacement = document.createElement('div');
    replacement.innerHTML = renderField(field, getPath(values, field.key), meta[field.key] ?? {});
    const fresh = replacement.firstElementChild;
    wrapper.replaceWith(fresh);

    const host = fresh.querySelector(`.chips[data-chips="${CSS.escape(field.key)}"]`);
    if (host) {
      attachChips(
        host,
        () => getPath(values, field.key) ?? [],
        (next) => {
          setPath(values, field.key, next);
          rerenderField(field);
          markDirty();
        },
        toast,
      );
      host.querySelector('.chips__input')?.focus();
    }
  }

  const recomputeDirty = debounce(() => {
    dirty = JSON.stringify(values) !== JSON.stringify(initial);
    updateBar();
  }, 150);

  function markDirty() {
    dirty = true;
    updateBar();
    recomputeDirty();
  }

  function updateBar() {
    const bar = options.bar;
    if (!bar) return;
    bar.classList.toggle('formbar--dirty', dirty);
    const saveButton = bar.querySelector('[data-action="save"]');
    const revertButton = bar.querySelector('[data-action="revert"]');
    if (saveButton) saveButton.disabled = !dirty;
    if (revertButton) revertButton.disabled = !dirty;
    const stateEl = bar.querySelector('.formbar__state');
    if (stateEl && !stateEl.dataset.sticky) {
      stateEl.textContent = dirty ? 'Unsaved changes' : 'All changes saved';
    }
  }

  function onEdit(event) {
    const wrapper = event.target.closest('.ff');
    if (!wrapper) return;
    const key = wrapper.dataset.key;
    const field = fields.find((f) => f.key === key);
    if (!field || field.type === 'list') return;

    setPath(values, key, readField(field, root));
    wrapper.classList.toggle(
      'ff--dirty',
      JSON.stringify(getPath(values, key)) !== JSON.stringify(getPath(initial, key)),
    );
    markDirty();

    // A field may reveal or hide others, and a hidden field keeps its value so
    // switching a provider away and back does not wipe the key you just typed.
    if (fields.some((f) => f.dependsOn)) {
      for (const candidate of fields) {
        const element = root.querySelector(`.ff[data-key="${CSS.escape(candidate.key)}"]`);
        if (element) element.hidden = !visible(candidate);
      }
    }
    options.onEdit?.(values, root);
  }

  root.addEventListener('input', onEdit);
  root.addEventListener('change', onEdit);

  function setState(text, sticky) {
    const stateEl = options.bar?.querySelector('.formbar__state');
    if (!stateEl) return;
    stateEl.textContent = text;
    if (sticky) stateEl.dataset.sticky = '1';
    else delete stateEl.dataset.sticky;
  }

  async function commit() {
    for (const flush of chipCommits) flush();
    clearFieldErrors(root);
    setState('Saving…', true);

    try {
      const result = await save(clone(values));
      initial = clone(values);
      dirty = false;
      for (const element of root.querySelectorAll('.ff--dirty')) {
        element.classList.remove('ff--dirty');
      }
      setState('Saved', false);
      updateBar();
      options.onSaved?.(result);
      return true;
    } catch (err) {
      setState('Not saved', false);
      applyErrors(err);
      return false;
    }
  }

  function applyErrors(err) {
    const unmatched = [];
    for (const issue of err.fields ?? []) {
      if (!showFieldError(root, issue.path, issue.message)) unmatched.push(issue);
    }

    const formError = options.bar?.querySelector('.formbar__error');
    if (formError) {
      // An issue whose path matches no descriptor must still be visible, or a
      // field the descriptors forgot would fail to save with no explanation.
      const extra = unmatched.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message));
      const text = [err.message, ...extra].filter(Boolean).join(' · ');
      formError.textContent = err.fields?.length && unmatched.length === 0 ? '' : text;
      formError.hidden = formError.textContent === '';
    }

    const first = root.querySelector('.ff--invalid');
    if (first) {
      first.scrollIntoView({ block: 'center', behavior: 'smooth' });
      first.querySelector('.ff__control')?.focus();
      toast(
        `Could not save — ${err.fields.length} field${err.fields.length === 1 ? '' : 's'} need attention`,
      );
    } else {
      toast(err.message);
    }
  }

  return {
    load(payload) {
      groups = payload.groups ?? [];
      fields = payload.fields ?? [];
      meta = payload.meta ?? {};
      initial = clone(payload.values);
      values = clone(payload.values);
      dirty = false;
      render();
    },
    revert() {
      values = clone(initial);
      dirty = false;
      clearFieldErrors(root);
      render();
      setState('Reverted', false);
    },
    save: commit,
    isDirty: () => dirty,
    values: () => clone(values),
  };
}
