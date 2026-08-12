import { createContext, use } from 'react';
import type { Mode, Theme, ThemeChoice } from './storage';

/** The theme selection, plus the two ways to change it. */
export interface ThemeContextValue extends ThemeChoice {
  setTheme: (theme: Theme) => void;
  setMode: (mode: Mode) => void;
}

/**
 * Held here rather than in `ThemeProvider.tsx` so that file exports nothing
 * but its component — `react-refresh/only-export-components` is an error, and
 * a mixed module breaks fast refresh during development.
 */
export const ThemeContext = createContext<ThemeContextValue | null>(null);

/** Reads the current theme selection. Throws outside a `ThemeProvider`. */
export const useTheme = (): ThemeContextValue => {
  const value = use(ThemeContext);
  if (value === null) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return value;
};
