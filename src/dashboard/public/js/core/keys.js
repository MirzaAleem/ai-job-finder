import { closeTopModal, isModalOpen, openModal } from './modal.js';
import { activeView, navigate } from './router.js';

const TAB_ORDER = ['jobs', 'run', 'history', 'settings', 'profile'];

function isTyping(event) {
  const target = event.target;
  return /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable;
}

/**
 * One keydown listener for the whole app.
 *
 * Global keys are handled here; anything else is offered to the active view.
 * Keeping it in one place means the "is the user typing?" guard exists once
 * and cannot drift between views now that most of the UI is form fields.
 */
export function initKeys() {
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (!closeTopModal() && isTyping(event)) event.target.blur();
      return;
    }

    if (isModalOpen()) return;

    // Handled before the modifier bail, since it is deliberately a chord.
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      activeView()?.onSubmitKey?.(event);
      return;
    }

    if (isTyping(event) || event.metaKey || event.ctrlKey || event.altKey) return;

    const tabIndex = Number(event.key) - 1;
    if (Number.isInteger(tabIndex) && tabIndex >= 0 && tabIndex < TAB_ORDER.length) {
      event.preventDefault();
      navigate(TAB_ORDER[tabIndex]);
      return;
    }

    if (event.key === '?') {
      openModal('help');
      return;
    }
    if (event.key === 'r') {
      activeView()?.refresh?.();
      return;
    }

    activeView()?.onKey?.(event);
  });
}
