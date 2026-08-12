/// <reference types="vite/client" />

// Declares the module shapes Vite resolves but TypeScript cannot infer — most
// visibly `*.css`, which every component imports for its side effect only.
//
// Without this, TypeScript 6 fails each of those imports with TS2882 ("cannot
// find module or type declarations for side-effect import"). TypeScript 5.9
// does not perform that check, so `npm run typecheck` passed on the pinned
// 5.9.3 while an editor running its own bundled 6.x reported errors on files
// the command line called clean — the imports were always undeclared, only the
// checking differed.
//
// A triple-slash reference still resolves under `"types": []`: that setting
// governs automatic `@types/*` inclusion, not explicit references. `vite/client`
// is browser-only and pulls in no Node types, so the ADR-022 boundary the empty
// `types` array protects is unaffected.
