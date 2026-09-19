import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'output/**', 'coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      'no-console': 'off',
      eqeqeq: ['error', 'always'],
    },
  },
  {
    // The dashboard client runs in a browser, not in Node. It is plain JS with
    // no build step, so it gets browser globals and none of the TS rules.
    files: ['src/dashboard/public/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        document: 'readonly',
        window: 'readonly',
        location: 'readonly',
        history: 'readonly',
        fetch: 'readonly',
        localStorage: 'readonly',
        matchMedia: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        URLSearchParams: 'readonly',
        console: 'readonly',
        CSS: 'readonly',
        Event: 'readonly',
        CustomEvent: 'readonly',
        EventSource: 'readonly',
        AbortController: 'readonly',
        FormData: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        requestAnimationFrame: 'readonly',
        cancelAnimationFrame: 'readonly',
        navigator: 'readonly',
        structuredClone: 'readonly',
        alert: 'readonly',
        confirm: 'readonly',
        Node: 'readonly',
      },
    },
  },
  prettier,
);
