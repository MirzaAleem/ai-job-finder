import { $ } from './dom.js';

/**
 * Hash routing, because the server has no HTML history fallback — a request
 * for /settings returns a JSON 404.
 *
 * Views are static containers that are present from first paint and toggled
 * with the `hidden` attribute, so switching tabs costs no DOM rebuild and the
 * Jobs list keeps its scroll position and selection. Filters stay in
 * location.search and are untouched by any of this.
 */
const views = new Map();
let active = null;
let fallback = null;

export function registerView(view) {
  views.set(view.name, view);
  fallback ??= view.name;
}

export function activeView() {
  return active;
}

export function routeName() {
  const raw = location.hash.replace(/^#\/?/, '').split('?')[0];
  return views.has(raw) ? raw : fallback;
}

export async function go(name) {
  const next = views.get(name) ?? views.get(fallback);
  if (!next) return;

  if (active === next) {
    next.refresh?.();
    return;
  }

  // A view with unsaved changes gets to stop the move.
  if (active?.beforeLeave && !(await active.beforeLeave())) {
    if (location.hash !== `#/${active.name}`) {
      history.replaceState(null, '', `${location.pathname}${location.search}#/${active.name}`);
    }
    return;
  }

  if (active) {
    active.hide?.();
    $(`view-${active.name}`)?.setAttribute('hidden', '');
  }

  active = next;
  $(`view-${next.name}`)?.removeAttribute('hidden');

  for (const tab of document.querySelectorAll('.tab')) {
    if (tab.dataset.view === next.name) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  }

  if (!next.mounted) {
    next.mounted = true;
    next.mount?.();
  }
  next.show?.();
}

export function navigate(name) {
  if (location.hash === `#/${name}`) go(name);
  else location.hash = `#/${name}`;
}

export function initRouter() {
  window.addEventListener('hashchange', () => go(routeName()));

  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', (event) => {
      // Drive the router directly: a hashchange cannot be cancelled, and
      // beforeLeave has to be able to keep you on a dirty form.
      event.preventDefault();
      navigate(tab.dataset.view);
    });
  }

  go(routeName());
}
