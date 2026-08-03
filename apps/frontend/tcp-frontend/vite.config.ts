/// <reference types="vitest/config" />
import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv, type Plugin } from 'vite';

const repoRoot = resolve(import.meta.dirname, '../../..');

/**
 * Reads the repo's `EXPOSE_PORT_*` convention rather than hardcoding a port.
 * `loadEnv` merges matching `process.env` entries over the file values, so a
 * shell that has already sourced the env file wins.
 *
 * `envDir` is deliberately left alone: pointing Vite's own env loading at the
 * repo root would put `.env.dev.local` — which holds generated OIDC
 * credentials — on the bundler's load path. This reads the files directly and
 * filters to the one prefix it needs.
 */
const exposePorts = loadEnv('dev', repoRoot, 'EXPOSE_PORT_');

/**
 * Layer 3 of the `@tcp/shared` import boundary (ADR-022).
 *
 * The ADR assumed the bundler would fail on its own when it met `typeorm` or
 * `ioredis`. It does not: Vite externalises Node built-ins with a *warning*
 * and builds successfully, turning a 250 kB bundle into a 4.5 MB one carrying
 * express, multer and busboy — code that then fails at runtime, in a browser,
 * with no clue where it came from. Verified in 002.01.
 *
 * So the layer is made explicit. Failing at resolve time also covers the
 * development server, which the ADR's version never would have.
 */
const forbidServerOnlyShared = (): Plugin => ({
  name: 'tcp:forbid-server-only-shared',
  enforce: 'pre',
  resolveId(source) {
    if (source === '@tcp/shared' || source.startsWith('@tcp/shared/')) {
      if (source === '@tcp/shared/client') return null;
      throw new Error(
        `"${source}" is server-only. Import from '@tcp/shared/client' instead — ` +
          'the default export pulls in TypeORM, BullMQ, ioredis and MinIO, ' +
          'none of which run in a browser (ADR-022).',
      );
    }
    return null;
  },
});

export default defineConfig({
  plugins: [react(), forbidServerOnlyShared()],
  server: {
    port: Number(exposePorts.EXPOSE_PORT_WEB ?? 5173),
    // Fail loudly on a port collision rather than silently picking another —
    // the deployment scripts pre-flight these ports and expect the declared one.
    strictPort: true,
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
    css: true,
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
