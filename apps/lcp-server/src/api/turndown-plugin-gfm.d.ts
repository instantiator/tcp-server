// Ambient declaration for turndown-plugin-gfm — it ships no types of its own
// and there is no @types/turndown-plugin-gfm package. Only the `gfm` export
// used by knowledge-conversion.ts is declared (see lib/turndown-plugin-gfm.cjs.js
// in the installed package for the full, untyped surface: gfm re-exports
// highlightedCodeBlock/strikethrough/tables/taskListItems as one plugin).
declare module 'turndown-plugin-gfm' {
  import TurndownService from 'turndown';

  export function gfm(service: TurndownService): void;
}
