import { escapeHtml } from '../core/dom.js';

/**
 * The string-list editor, used by seven profile fields.
 *
 * Pasting splits on commas and newlines, because people arrive with a list of
 * skills copied from a CV and typing them one at a time is miserable.
 */
export function renderChips(field, values) {
  const items = Array.isArray(values) ? values : [];
  return `
<div class="chips" data-chips="${escapeHtml(field.key)}">
  <ul class="chips__items">
    ${items
      .map(
        (item, index) => `
      <li class="chip"><span class="chip__text">${escapeHtml(item)}</span>
        <button type="button" class="chip__x" data-action="chip-remove" data-index="${index}"
                aria-label="Remove ${escapeHtml(item)}">&times;</button></li>`,
      )
      .join('')}
  </ul>
  <input class="chips__input" type="text" autocomplete="off"
         placeholder="${escapeHtml(field.placeholder ?? 'Type and press Enter')}" />
</div>`;
}

export function splitPasted(text) {
  return text
    .split(/[,\n\r]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * Wire one chips editor. `onChange` receives the complete new array.
 * Returns a `commit` that flushes half-typed text, so a value is never lost
 * just because the user hit Save without pressing Enter first.
 */
export function attachChips(root, getValues, onChange, notify) {
  const input = root.querySelector('.chips__input');

  const add = (candidates) => {
    const current = [...getValues()];
    let added = false;
    for (const candidate of candidates) {
      if (current.includes(candidate)) {
        notify?.(`"${candidate}" is already in the list`);
        continue;
      }
      current.push(candidate);
      added = true;
    }
    if (added) onChange(current);
    return added;
  };

  root.addEventListener('click', (event) => {
    const button = event.target.closest('[data-action="chip-remove"]');
    if (!button) return;
    const next = [...getValues()];
    next.splice(Number(button.dataset.index), 1);
    onChange(next);
  });

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault();
      const parts = splitPasted(input.value);
      if (parts.length > 0 && add(parts)) input.value = '';
      return;
    }
    if (event.key === 'Backspace' && input.value === '') {
      const next = [...getValues()];
      if (next.length === 0) return;
      event.preventDefault();
      next.pop();
      onChange(next);
    }
  });

  input.addEventListener('paste', (event) => {
    const text = event.clipboardData?.getData('text') ?? '';
    if (!/[,\n\r]/.test(text)) return;
    event.preventDefault();
    if (add(splitPasted(text))) input.value = '';
  });

  const commit = () => {
    const parts = splitPasted(input.value);
    if (parts.length > 0 && add(parts)) input.value = '';
  };

  input.addEventListener('blur', commit);
  return commit;
}
