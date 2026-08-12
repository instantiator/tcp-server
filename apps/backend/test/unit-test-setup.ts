/**
 * Global setup for the unit-test project (see package.json's `jest` key,
 * wired via `setupFilesAfterEnv`).
 *
 * A handful of CLI actions (`eavesdrop.action.ts`, `render.ts`,
 * `chat/action.ts`) read `process.stdout.isTTY`/`.columns` directly to pick a
 * colour style and a wrap width. Left alone, that makes their specs'
 * byte-level output assertions depend on whoever's actually running the
 * suite — piped/CI (no TTY, `columns` undefined) versus an interactive
 * terminal (a real TTY, real width) render differently, so the exact same
 * test can pass or fail purely based on how it was invoked. Forcing a fixed,
 * non-interactive terminal shape for every test removes that as a variable;
 * a test that specifically wants to exercise TTY/width-dependent behaviour
 * can still override `process.stdout.isTTY`/`.columns` locally.
 */
let originalIsTTY: typeof process.stdout.isTTY;
let originalColumns: typeof process.stdout.columns;

beforeEach(() => {
  originalIsTTY = process.stdout.isTTY;
  originalColumns = process.stdout.columns;
  process.stdout.isTTY = false;
  process.stdout.columns = 120;
});

afterEach(() => {
  process.stdout.isTTY = originalIsTTY;
  process.stdout.columns = originalColumns;
});
