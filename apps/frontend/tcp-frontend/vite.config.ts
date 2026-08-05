/// <reference types="vitest/config" />
import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv, type Plugin } from 'vite';

const repoRoot = resolve(import.meta.dirname, '../../..');

/**
 * Hands `localStorage` and `sessionStorage` back to jsdom in the test tier.
 *
 * Node 25 turned the Web Storage API on by default, making both names own
 * properties of globalThis. Vitest declines to copy a jsdom global over a name
 * the runtime already defines, so jsdom's implementations stopped being
 * installed and the names read back as `undefined` — Node only populates them
 * given `--localstorage-file`. Switching Node's version off restores jsdom's
 * (vitest-dev/vitest#8757); drop this once vitest populates web storage itself.
 *
 * The flag has to reach the pool worker at startup, which `poolOptions.execArgv`
 * does not manage and `test.env` applies too late. Setting it here — rather than
 * in the npm script — means a bare `vitest`, a watch run and an IDE runner are
 * all covered, since workers inherit this process's environment and the config
 * is evaluated before any of them are forked.
 */
const disableNodeWebStorage = (): void => {
  const flag = '--no-webstorage';
  const existing = process.env.NODE_OPTIONS ?? '';
  if (!existing.includes(flag)) {
    process.env.NODE_OPTIONS = `${existing} ${flag}`.trim();
  }
};

disableNodeWebStorage();

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
    // EXPOSE_PORT_WEB_DEV, not EXPOSE_PORT_WEB: nginx (tcp-web) owns the
    // latter, and it is the HTTPS/HTTP2 address people and tests actually use.
    // This server is the plain-HTTP upstream behind it, reached through the
    // --dev-web overlay rather than by a browser directly (ADR-029).
    port: Number(exposePorts.EXPOSE_PORT_WEB_DEV ?? 4173),
    // Listen on all interfaces, not just loopback. The --dev-web overlay puts
    // nginx in front of this server from inside a container, reaching it via
    // host.docker.internal — which arrives on the host's bridge interface, not
    // on 127.0.0.1, so a loopback-only bind answers that with a 502.
    //
    // This does open the port to the local network. Vite's `allowedHosts`
    // still rejects any request whose Host header isn't localhost, so reaching
    // it by LAN address gets a refusal rather than your source — but treat it
    // as an open port on an untrusted network regardless.
    host: true,
    // Fail loudly on a port collision rather than silently picking another —
    // the deployment scripts pre-flight these ports and expect the declared one.
    strictPort: true,
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
    // Node 25 turned the Web Storage API on by default, so `localStorage` and
    // `sessionStorage` became own properties of globalThis. Vitest declines to
    // copy a jsdom global over a name the runtime already defines, so jsdom's
    // implementations stopped being installed and both names read back as
    // `undefined` — Node only populates them given --localstorage-file. Turning
    // Node's version off hands the names back to jsdom (vitest-dev/vitest#8757).
    //
    // (Web Storage is handed back to jsdom in disableNodeWebStorage(), above.)
    css: true,
    include: ['src/**/*.test.{ts,tsx}'],
    // The five Jest tiers write JUnit XML into the repo-root test-results/ for
    // CI's reporter to pick up. This tier reports the same way, so the CI job
    // needs no special case (ADR-028).
    reporters: ['default', 'junit'],
    outputFile: { junit: '../../../test-results/frontend.xml' },
  },
});
