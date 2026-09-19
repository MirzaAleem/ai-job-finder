import { $ } from './dom.js';

const KEY = 'jobfinder-theme';

function applyTheme(theme) {
  if (theme) document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
}

export function initTheme() {
  try {
    applyTheme(localStorage.getItem(KEY));
  } catch {
    /* private browsing — the system theme is a fine fallback */
  }

  $('theme-btn')?.addEventListener('click', () => {
    const current = document.documentElement.dataset.theme;
    const prefersDark = matchMedia('(prefers-color-scheme: dark)').matches;
    const next = current ? (current === 'dark' ? 'light' : 'dark') : prefersDark ? 'light' : 'dark';
    applyTheme(next);
    try {
      localStorage.setItem(KEY, next);
    } catch {
      /* not fatal */
    }
  });
}
