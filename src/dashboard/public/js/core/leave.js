import { $ } from './dom.js';
import { closeModal, openModal } from './modal.js';

/**
 * "You have unsaved changes" for form views.
 *
 * A real modal rather than confirm(), which is blocking, unstyleable and
 * suppressible. One resolver here, shared by every form, because the router
 * only ever asks one view at a time.
 */
let resolve = null;

function answer(value) {
  const settle = resolve;
  resolve = null;
  closeModal('leave-confirm');
  settle?.(value);
}

export function initLeaveConfirm() {
  $('leave-discard')?.addEventListener('click', () => answer(true));
  $('leave-stay')?.addEventListener('click', () => answer(false));
  // Dismissing the dialog any other way means "stay" — the safe reading.
  $('leave-confirm')?.addEventListener('click', (event) => {
    if (event.target === $('leave-confirm')) answer(false);
  });
}

export function confirmLeave(form) {
  if (!form?.isDirty()) return Promise.resolve(true);
  openModal('leave-confirm');
  return new Promise((settle) => {
    resolve = settle;
  });
}

/** Warn on tab close too, where a modal is not an option. */
export function initUnloadGuard(isDirty) {
  window.addEventListener('beforeunload', (event) => {
    if (!isDirty()) return;
    event.preventDefault();
    event.returnValue = '';
  });
}
