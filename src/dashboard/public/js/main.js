/* Job Finder dashboard — vanilla ES modules, no build step, no dependencies. */

import { $ } from './core/dom.js';
import { initKeys } from './core/keys.js';
import { initLeaveConfirm, initUnloadGuard } from './core/leave.js';
import { initModals, openModal } from './core/modal.js';
import { initRouter, registerView } from './core/router.js';
import { initTheme } from './core/theme.js';
import { historyView } from './views/history.js';
import { jobsView } from './views/jobs.js';
import { profileView } from './views/profile.js';
import { runView } from './views/run.js';
import { settingsView } from './views/settings.js';

// Order matters: it is the tab order and the 1..5 shortcut order.
const VIEWS = [jobsView, runView, historyView, settingsView, profileView];

function boot() {
  // Module scripts are deferred, so this runs after the document is parsed.
  for (const view of VIEWS) registerView(view);

  initTheme();
  initModals();
  initLeaveConfirm();
  initKeys();
  initUnloadGuard(() => VIEWS.some((view) => view.isDirty?.()));

  $('help-btn')?.addEventListener('click', () => openModal('help'));
  $('refresh-btn')?.addEventListener('click', () => {
    const view = VIEWS.find((v) => v.mounted && !$(`view-${v.name}`)?.hidden);
    view?.refresh?.();
  });

  // The run stream is opened regardless of which tab is showing, so a run
  // started here keeps reporting while you read the job list.
  runView.boot();

  initRouter();
}

boot();
