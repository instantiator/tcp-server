/**
 * The theme choice and where it is kept.
 *
 * Theme selection is an explicit user choice. The browser's `prefers-color-scheme`
 * and `prefers-contrast` settings seed the *first* visit and are then never
 * consulted again — the system settings set the starting point, they don't
 * override the user (ADR-026).
 *
 * The inline script in `index.html` duplicates {@link resolveThemeChoice} and
 * {@link applyThemeChoice}, because it has to run before the bundle loads and
 * therefore cannot import them. Change one, change the other; the storage key
 * and the two attribute names are the shared contract.
 */

/** Colour palette. `high-contrast` is the AAA (7:1) theme. */
export type Theme = 'default' | 'high-contrast';

/** Light or dark variant of a {@link Theme}. */
export type Mode = 'light' | 'dark';

/** A complete theme selection: one palette, one variant. */
export interface ThemeChoice {
  theme: Theme;
  mode: Mode;
}

/** Shared with the pre-paint script in `index.html`. */
export const THEME_STORAGE_KEY = 'tcp.theme';

const THEMES: readonly string[] = ['default', 'high-contrast'];
const MODES: readonly string[] = ['light', 'dark'];

/**
 * Reads a previously persisted choice, or `null` when there is none.
 *
 * Anything unrecognised is treated as absent rather than as an error: a
 * corrupt or outdated entry should reseed from the system settings, not leave
 * the application unstyled.
 */
export const readThemeChoice = (): ThemeChoice | null => {
  try {
    // Storage can be unavailable (private browsing, blocked cookies), in
    // which case seeding from the system settings on every load is the right
    // fallback — the same one an absent entry gets.
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    if (raw === null) return null;

    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { theme, mode } = parsed as Record<string, unknown>;
    if (typeof theme !== 'string' || !THEMES.includes(theme)) return null;
    if (typeof mode !== 'string' || !MODES.includes(mode)) return null;
    return { theme: theme as Theme, mode: mode as Mode };
  } catch {
    return null;
  }
};

/** Derives a starting choice from the browser's accessibility preferences. */
export const seedThemeChoice = (): ThemeChoice => ({
  theme: window.matchMedia('(prefers-contrast: more)').matches
    ? 'high-contrast'
    : 'default',
  mode: window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light',
});

/** The persisted choice if there is one, otherwise a freshly seeded one. */
export const resolveThemeChoice = (): ThemeChoice =>
  readThemeChoice() ?? seedThemeChoice();

/** Persists a choice, ignoring a storage backend that refuses to write. */
export const writeThemeChoice = (choice: ThemeChoice): void => {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify(choice));
  } catch {
    // A choice that cannot be persisted still applies for this page view.
  }
};

/** Puts the choice on `<html>`, where the theme stylesheets select on it. */
export const applyThemeChoice = ({ theme, mode }: ThemeChoice): void => {
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.mode = mode;
};
