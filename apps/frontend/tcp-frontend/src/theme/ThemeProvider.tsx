import { useCallback, useState, type ReactNode } from 'react';
import {
  applyThemeChoice,
  resolveThemeChoice,
  writeThemeChoice,
  type Mode,
  type Theme,
  type ThemeChoice,
} from './storage';
import { ThemeContext } from './useTheme';

/**
 * Owns the theme selection: one of the few genuinely client-side pieces of
 * state in this application (ADR-021).
 *
 * The initial choice is resolved and persisted during the first render rather
 * than in an effect, so a seeded first visit is remembered from that point on.
 * The inline script in `index.html` has already applied the same choice to
 * `<html>` before this runs — reapplying it here is what keeps the two in step
 * if they ever disagree.
 */
export const ThemeProvider = ({ children }: { children: ReactNode }) => {
  const [choice, setChoice] = useState<ThemeChoice>(() => {
    const initial = resolveThemeChoice();
    writeThemeChoice(initial);
    applyThemeChoice(initial);
    return initial;
  });

  const update = useCallback((next: ThemeChoice) => {
    writeThemeChoice(next);
    applyThemeChoice(next);
    setChoice(next);
  }, []);

  const setTheme = useCallback(
    (theme: Theme) => {
      update({ ...choice, theme });
    },
    [choice, update],
  );

  const setMode = useCallback(
    (mode: Mode) => {
      update({ ...choice, mode });
    },
    [choice, update],
  );

  return (
    <ThemeContext value={{ ...choice, setTheme, setMode }}>
      {children}
    </ThemeContext>
  );
};
