// @ts-check
// The browser workspace's lint configuration. Split out of the root
// eslint.config.mjs in 002.01: that config sets `sourceType: 'commonjs'` and
// Node globals, neither of which is right for a React bundle (ADR-022).
//
// The root config now ignores apps/frontend/** entirely; the root `lint` and
// `lint:check` scripts reach this file through `npm run … --workspaces`.
import js from '@eslint/js';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // The import-boundary fixture is deliberately broken and must not fail the
    // ordinary lint sweep. `test:import-boundary` re-enables it with
    // --no-ignore and asserts that no-restricted-imports fires (ADR-022).
    ignores: [
      'dist/**',
      'eslint.config.mjs',
      'vite.config.ts',
      'test/fixtures/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      globals: globals.browser,
      sourceType: 'module',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  // Accessibility is the MVP's quality bar, so these are errors rather than
  // warnings — the repo's gate treats a warning as a failure anyway, and
  // stating it here means the severity survives a change to that gate
  // (ADR-026).
  {
    ...jsxA11y.flatConfigs.recommended,
    files: ['**/*.{ts,tsx}'],
    rules: Object.fromEntries(
      Object.keys(jsxA11y.flatConfigs.recommended.rules ?? {}).map((rule) => [
        rule,
        'error',
      ]),
    ),
  },
  // react-hooks v7 ships its preset with a legacy string-array `plugins` key,
  // which eslint 10 rejects outright — so the two rules that matter are wired
  // by hand. The rest of v7's preset is React Compiler linting, which this
  // application does not use.
  {
    files: ['**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks, 'react-refresh': reactRefresh },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
      'react-refresh/only-export-components': 'error',
    },
  },
  eslintPluginPrettierRecommended,
  {
    rules: {
      '@typescript-eslint/no-deprecated': 'error',
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      'prettier/prettier': ['error', { endOfLine: 'auto' }],
      // Layer 2 of the @tcp/shared boundary (ADR-022). The bare specifier
      // resolves fine through node_modules — this is what makes it fail, at
      // edit time, with a message naming the replacement rather than a
      // bundler stack trace about `typeorm`.
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@tcp/shared',
              message:
                "Import from '@tcp/shared/client' instead. The default export is server-only — it pulls in TypeORM, BullMQ, ioredis and MinIO, none of which run in a browser.",
            },
          ],
          patterns: [
            {
              group: ['@tcp/shared/*', '!@tcp/shared/client'],
              message:
                "Only '@tcp/shared/client' is browser-safe. Deep imports into @tcp/shared bypass its exports map.",
            },
          ],
        },
      ],
    },
  },
  {
    // The import-boundary fixture belongs to no tsconfig on purpose, so the
    // project service cannot type it and typed rules must be off for it.
    // `no-restricted-imports` is a core rule and still fires — which is what
    // `npm run test:import-boundary` asserts.
    ...tseslint.configs.disableTypeChecked,
    files: ['test/fixtures/**/*.ts'],
  },
);
