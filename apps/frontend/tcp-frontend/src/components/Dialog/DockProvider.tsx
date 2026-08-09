import { useMemo, useState, type ReactNode } from 'react';
import { Button } from 'react-aria-components';
import { t } from '../../strings';
import { DockContext, type DockContextValue, type DockEntry } from './useDock';
import './DockProvider.css';

/**
 * Holds the minimised dialogs and renders the bar they sit in.
 *
 * A dialog is minimised rather than closed by unmounting it and leaving an
 * entry here — see `Dialog.tsx` for why a parked modal cannot stay mounted.
 * The dialog's own state stays with whatever opened it; this only remembers
 * how to put it back.
 *
 * ponytail: deliberately just a list and a row of buttons. Its only consumer
 * is the chat dialog (008.02), which has not been designed yet — anything more
 * would be guessing at requirements. 008.02 should extend this to fit rather
 * than work around it.
 *
 * The bar renders only when something is in it, so an empty dock is not a
 * landmark a screen reader user has to skip past on every page.
 */
export const DockProvider = ({ children }: { children: ReactNode }) => {
  const [entries, setEntries] = useState<readonly DockEntry[]>([]);

  const dock = useMemo<DockContextValue>(
    () => ({
      entries,
      minimise: (entry) => {
        setEntries((previous) => [
          ...previous.filter((e) => e.id !== entry.id),
          entry,
        ]);
      },
      restore: (id) => {
        const entry = entries.find((e) => e.id === id);
        if (entry === undefined) return;
        setEntries((previous) => previous.filter((e) => e.id !== id));
        // Called outside the state updater on purpose: React invokes an
        // updater twice under StrictMode, which would re-open the dialog twice.
        entry.restore();
      },
    }),
    [entries],
  );

  return (
    <DockContext.Provider value={dock}>
      {children}
      {entries.length > 0 && (
        <nav className="dialog-dock" aria-label={t('dock.label')}>
          <ul className="dialog-dock__list">
            {entries.map((entry) => (
              <li key={entry.id}>
                <Button
                  className="react-aria-Button dialog-dock__item"
                  onPress={() => {
                    dock.restore(entry.id);
                  }}
                >
                  {entry.label}
                </Button>
              </li>
            ))}
          </ul>
        </nav>
      )}
    </DockContext.Provider>
  );
};
