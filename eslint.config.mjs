// @ts-check
import eslint from '@eslint/js';
import eslintPluginJsonc from 'eslint-plugin-jsonc';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // tcp-stub-llm is a standalone app with its own package.json, tsconfig,
    // and eslint config — it shares no code or tooling with the rest of this
    // monorepo, so the root config (and root `npm run lint`) must not sweep
    // it in even though it sits under apps/.
    // The import-boundary fixture is deliberately broken and must not fail
    // the ordinary lint sweep; tcp-frontend's `test:import-boundary` lints it
    // with --no-ignore and asserts the rule fires. See ADR-022.
    ignores: [
      'eslint.config.mjs',
      'apps/tcp-stub-llm/**',
      'apps/frontend/tcp-frontend/test/fixtures/**',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  eslintPluginPrettierRecommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },
      sourceType: 'commonjs',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-deprecated': 'error',
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      "prettier/prettier": ["error", { endOfLine: "auto" }],
    },
  },
  // The browser workspace. It shares this config file (one lint entry point,
  // one cache) but not its language options: no Node globals, ES modules
  // rather than CommonJS. When 002.01 brings React and TSX in, this block is
  // the natural seam to split into apps/frontend/tcp-frontend/eslint.config.mjs.
  {
    files: ['apps/frontend/**/*.{ts,tsx}'],
    languageOptions: {
      globals: globals.browser,
      sourceType: 'module',
    },
    rules: {
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
    // `no-restricted-imports` is a core rule and still fires. Same mechanism
    // as the .jsonc block below.
    ...tseslint.configs.disableTypeChecked,
    files: ['apps/frontend/tcp-frontend/test/fixtures/**/*.ts'],
  },
  {
    // Jest mocks accessed via typed objects legitimately trigger unbound-method;
    // the rule is too strict for spec files.
    files: ['**/*.spec.ts'],
    rules: {
      '@typescript-eslint/unbound-method': 'off',
    },
  },
  // .jsonc files (prompts/tools config) — parsed separately from the TS rules
  // above; Prettier (via .prettierrc's "*.jsonc" override) is the sole
  // formatting authority, so jsonc's own stylistic rules are disabled.
  {
    ...tseslint.configs.disableTypeChecked,
    files: ['apps/**/*.jsonc'],
  },
  ...eslintPluginJsonc.configs['flat/base'].map((c) => ({
    ...c,
    files: ['apps/**/*.jsonc'],
  })),
  ...eslintPluginJsonc.configs['flat/prettier'].map((c) => ({
    ...c,
    files: ['apps/**/*.jsonc'],
  })),
  {
    files: ['apps/**/*.jsonc'],
    rules: {
      'prettier/prettier': ['error', { endOfLine: 'auto' }],
    },
  },
);
