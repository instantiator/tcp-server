const { resolve } = require('path');
const nodeExternals = require('webpack-node-externals');

/**
 * Overrides one field of the Nest CLI's default webpack config: `externals`.
 *
 * Two problems, both created by becoming an npm workspace:
 *
 * 1. Nest's default is `nodeExternals()`, which looks for `node_modules`
 *    relative to the CWD. `nest build` runs from this workspace, and npm hoists
 *    every dependency to the repository root, so that directory does not exist
 *    here — nothing got externalised and webpack tried to bundle the whole
 *    dependency tree, including optional peers it cannot resolve
 *    (`@mikro-orm/core`, `@nestjs/mongoose`) and `.d.ts`/`.js.map` files it has
 *    no loader for. `additionalModuleDirs` rather than `modulesDir`: a future
 *    version conflict would give this workspace its own `node_modules`, and
 *    both must be honoured.
 *
 * 2. `@tcp/shared` must stay **bundled**, not externalised. It used to be a
 *    bare tsconfig path alias, invisible to `nodeExternals`, so webpack inlined
 *    its TypeScript source. Now it resolves through a `node_modules` symlink,
 *    which makes `nodeExternals` treat it as a third-party package and emit a
 *    bare `require('@tcp/shared')`. The runtime images copy `node_modules` from
 *    `prod-deps` but not `libs/`, leaving that symlink dangling — the container
 *    then dies at startup with `Cannot find module '@tcp/shared'`. This fails
 *    only at runtime: the build, the typecheck and every test tier pass.
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
