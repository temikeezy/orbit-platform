import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  /*
   * Generated output, all of it gitignored and none of it ours to lint.
   *
   * `dist` was ignored; the others were not, so `npm run lint` started failing
   * on vendored JavaScript inside the coverage report the moment anyone ran the
   * tests with coverage. CI never saw it because lint runs before the test step
   * — which is the worst version of this: green in CI, red on the machine of
   * whoever just ran the full suite locally.
   */
  { ignores: ['dist', 'coverage', 'test-results', 'playwright-report', '.netlify'] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': [
        'warn',
        { allowConstantExport: true },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  }
);
