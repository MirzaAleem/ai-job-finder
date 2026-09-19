import { $ } from './dom.js';

/**
 * A modal stack with a focus trap.
 *
 * Visibility is the `hidden` attribute, which app.css forces to win over
 * .modal's display:flex. Without that rule an "open" modal with no content
 * still covers the page and silently eats every click.
 */
const stack = [];
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function openModal(id) {
  const element = $(id);
  if (!element || stack.includes(id)) return;

  stack.push(id);
  element.dataset.returnFocus = document.activeElement?.id ?? '';
  element.hidden = false;

  const first = element.querySelector(FOCUSABLE);
  first?.focus();
}

export function closeModal(id) {
  const index = stack.indexOf(id);
  if (index === -1) return;
  stack.splice(index, 1);

  const element = $(id);
  if (!element) return;
  element.hidden = true;

  const returnTo = element.dataset.returnFocus;
  if (returnTo) $(returnTo)?.focus();
}

export function closeTopModal() {
  const id = stack.at(-1);
  if (id) closeModal(id);
  return Boolean(id);
}

export const isModalOpen = () => stack.length > 0;

/** Trap Tab inside the top modal, and close on a backdrop click. */
export function initModals() {
  document.addEventListener('click', (event) => {
    const id = stack.at(-1);
    if (id && event.target === $(id)) closeModal(id);
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab') return;
    const id = stack.at(-1);
    if (!id) return;

    const panel = $(id);
    const items = [...panel.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null);
    if (items.length === 0) return;

    const first = items[0];
    const last = items.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });

  for (const element of document.querySelectorAll('.modal')) {
    for (const button of element.querySelectorAll('[data-action="close-modal"]')) {
      button.addEventListener('click', () => closeModal(element.id));
    }
  }
}
