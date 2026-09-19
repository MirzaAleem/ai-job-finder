import { escapeHtml, fieldId } from '../core/dom.js';
import { renderChips } from './chips.js';

/**
 * Descriptor -> HTML, and DOM -> value.
 *
 * Forms are data here rather than hand-written markup: the settings
 * descriptors arrive from the server (so help text lives next to the schema
 * that validates it) and the profile descriptors sit alongside this file.
 */

function control(field, value) {
  const id = fieldId(field.key);
  const described = `${id}-help`;
  const common = `id="${id}" class="ff__control" aria-describedby="${described}"`;
  const text = escapeHtml(value ?? '');

  switch (field.type) {
    case 'boolean':
      return `<label class="switch">
        <input type="checkbox" ${common} ${value === true || value === 'true' ? 'checked' : ''} />
        <span class="switch__track"></span>
        <span class="switch__label">${escapeHtml(field.onLabel ?? 'Enabled')}</span>
      </label>`;

    case 'enum':
    case 'select':
      return `<select ${common}>${(field.options ?? [])
        .map((option) => {
          const optValue = typeof option === 'string' ? option : option.value;
          const optLabel = typeof option === 'string' ? option : option.label;
          return `<option value="${escapeHtml(optValue)}" ${
            String(value) === String(optValue) ? 'selected' : ''
          }>${escapeHtml(optLabel)}</option>`;
        })
        .join('')}</select>`;

    case 'number':
      return `<input type="number" ${common} value="${text}"
        ${field.min !== undefined ? `min="${field.min}"` : ''}
        ${field.max !== undefined ? `max="${field.max}"` : ''}
        ${field.step !== undefined ? `step="${field.step}"` : ''}
        inputmode="${field.step && field.step < 1 ? 'decimal' : 'numeric'}" />
        ${field.unit ? `<span class="ff__unit">${escapeHtml(field.unit)}</span>` : ''}`;

    case 'textarea':
      return `<textarea ${common} rows="3"
        placeholder="${escapeHtml(field.placeholder ?? '')}">${text}</textarea>`;

    case 'list':
      return renderChips(field, value);

    case 'secret':
      // Plain text by explicit choice: this is a single-user tool bound to
      // loopback, and a masked key you cannot read is a support problem.
      return `<input type="text" ${common} value="${text}" spellcheck="false"
        autocomplete="off" autocapitalize="off" data-1p-ignore
        class="ff__control ff__control--mono"
        placeholder="${escapeHtml(field.placeholder ?? '')}" />`;

    case 'path':
    case 'csv':
      return `<input type="text" ${common} value="${text}" spellcheck="false"
        class="ff__control ff__control--mono"
        placeholder="${escapeHtml(field.placeholder ?? '')}" />`;

    default:
      return `<input type="text" ${common} value="${text}"
        placeholder="${escapeHtml(field.placeholder ?? '')}" />`;
  }
}

export function renderField(field, value, meta = {}) {
  const id = fieldId(field.key);
  const readOnly = Boolean(field.managedBy);

  const badge = meta.isDefault === false && !readOnly ? '<span class="ff__source">set</span>' : '';

  return `
<div class="ff ff--${field.type} ${readOnly ? 'ff--readonly' : ''}" data-key="${escapeHtml(field.key)}">
  <label class="ff__label" for="${id}">${escapeHtml(field.label)}${badge}</label>
  <p class="ff__help" id="${id}-help">${escapeHtml(field.help)}</p>
  ${
    field.caution
      ? `<p class="notice notice--warn ff__caution">${escapeHtml(field.caution)}</p>`
      : ''
  }
  <div class="ff__row">${readOnly ? renderReadOnly(field, value) : control(field, value)}</div>
  ${
    field.restartRequired
      ? '<p class="ff__note">Takes effect after the dashboard is restarted.</p>'
      : ''
  }
  <p class="ff__error" id="${id}-error" role="alert" hidden></p>
</div>`;
}

function renderReadOnly(field, value) {
  return `<span class="ff__readonly">${escapeHtml(value || '(not set)')}</span>
    <a class="linkbtn" href="#/${escapeHtml(field.managedBy.view)}">${escapeHtml(
      field.managedBy.label,
    )} &rarr;</a>`;
}

/** Read one field's value back out of the DOM, in the type the API expects. */
export function readField(field, root) {
  const element = root.querySelector(`#${CSS.escape(fieldId(field.key))}`);
  if (!element) return undefined;

  switch (field.type) {
    case 'boolean':
      return element.checked;
    case 'number': {
      const raw = element.value.trim();
      if (raw === '') return undefined;
      const parsed = Number(raw);
      // Hand back the raw text when it is not a number, so the server's
      // message names the field rather than the client inventing one.
      return Number.isNaN(parsed) ? raw : parsed;
    }
    default:
      return element.value;
  }
}

export function showFieldError(root, key, message) {
  const wrapper = root.querySelector(`.ff[data-key="${CSS.escape(key)}"]`);
  if (!wrapper) return false;
  const error = wrapper.querySelector('.ff__error');
  const control_ = wrapper.querySelector('.ff__control');
  wrapper.classList.add('ff--invalid');
  if (control_) control_.setAttribute('aria-invalid', 'true');
  if (error) {
    error.textContent = message;
    error.hidden = false;
  }
  return true;
}

export function clearFieldErrors(root) {
  for (const wrapper of root.querySelectorAll('.ff--invalid')) {
    wrapper.classList.remove('ff--invalid');
    wrapper.querySelector('.ff__control')?.removeAttribute('aria-invalid');
    const error = wrapper.querySelector('.ff__error');
    if (error) {
      error.textContent = '';
      error.hidden = true;
    }
  }
}
