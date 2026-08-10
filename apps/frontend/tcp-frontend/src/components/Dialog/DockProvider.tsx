import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
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
 * ponytail: still just a list and a row of buttons. 008.02 added three things
 * to it and nothing else: labels may be components rather than strings, an
 * entry can be removed without re-opening it, and focus can be sent to a
 * button. Each is there because the chat dialog cannot work without it.
 *
 * The bar renders only when something is in it, so an empty dock is not a
 * landmark a screen reader user has to skip past on every page.
 */
export const DockProvider = ({ children }: { children: ReactNode }) => {
  const [entries, setEntries] = useState<readonly DockEntry[]>([]);

  // Which button to focus once the bar has rendered, and the buttons to find it
  // among. Focus cannot be moved at the moment `focusEntry` is called: the
  // entry may not be on screen yet, and the dialog it replaced may not have
  // finished unmounting.
  const [pendingFocus, setPendingFocus] = useState<string | null>(null);
  const buttons = useRef(new Map<string, HTMLButtonElement>());

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
      remove: (id) => {
        setEntries((previous) => previous.filter((e) => e.id !== id));
      },
      focusEntry: (id) => {
        setPendingFocus(id);
      },
    }),
    [entries],
  );

  useEffect(() => {
    if (pendingFocus === null) return;
    const button = buttons.current.get(pendingFocus);
    if (button === undefined) return;

    // Deferred by a turn rather than focused here, because this is a race and
    // not a flake. React Aria's `Modal` returns focus to whatever opened the
    // dialog when the overlay unmounts, and it does so after this effect. The
    // dialog has just been minimised, so that restore is about to fire and
    // would take the focus straight back off this button.
    const handle = setTimeout(() => {
      button.focus();
      setPendingFocus(null);
    }, 0);
    return () => {
      clearTimeout(handle);
    };
  }, [pendingFocus, entries]);

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
                  ref={(element) => {
                    if (element === null) buttons.current.delete(entry.id);
                    else buttons.current.set(entry.id, element);
                  }}
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
