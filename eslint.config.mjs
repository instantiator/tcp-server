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
    //
    // The browser workspace is likewise excluded: this config sets
    // `sourceType: 'commonjs'` and Node globals, neither of which suits a
    // React bundle (ADR-022). It has its own
    // apps/frontend/tcp-frontend/eslint.config.mjs, which the root `lint` and
    // `lint:check` scripts reach through `npm run … --workspaces`.
    ignores: ['eslint.config.mjs', 'apps/tcp-stub-llm/**', 'apps/frontend/**'],
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
