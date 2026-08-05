const { resolve } = require('path');
const nodeExternals = require('webpack-node-externals');

/**
 * Overrides one field of the Nest CLI's default webpack config, `externals`,
 * which its `nodeExternals()` default gets wrong for a workspace member.
 *
 * `additionalModuleDirs` — `nodeExternals` searches for `node_modules` relative
 * to the CWD, and `nest build` runs from this workspace, where npm's hoisting
 * leaves none. Without this, nothing is externalised and webpack pulls in the
 * whole dependency tree, unresolvable optional peers (`@mikro-orm/core`,
 * `@nestjs/mongoose`) and loader-less `.d.ts`/`.js.map` files included.
 * `additionalModuleDirs` rather than `modulesDir` so a version conflict that
 * gives this workspace its own `node_modules` is still honoured.
 *
 * `allowlist` — `@tcp/shared` must be bundled from source, not externalised.
 * It resolves through a `node_modules` symlink into `libs/`, which the runtime
 * images do not copy, so a bare `require('@tcp/shared')` in the output kills
 * the container at startup. Nothing short of running an image catches that:
 * the build, the typecheck and every test tier pass either way.
 */
module.exports = (options) => ({
  ...options,
  externals: [
    nodeExternals({
      additionalModuleDirs: [resolve(__dirname, '../../node_modules')],
      allowlist: [/^@tcp\/shared(\/.*)?$/],
    }),
  ],
});
