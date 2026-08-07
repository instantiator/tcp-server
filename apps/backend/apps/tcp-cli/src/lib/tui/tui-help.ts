// The help overlay's fixed content. Shown in a TextPane opened with F1 or
// Ctrl+G — see Tui.showHelp.

/** Fixed id for the (at most one) help pane. */
export const HELP_PANE_ID = '__help__';

/** The help pane's text, one entry per rendered line. */
export const HELP_TEXT = [
  'Keyboard shortcuts',
  '',
  'Tab / Shift+Tab   Switch tabs',
  'Ctrl+W            Close the active tab (not the company roster)',
  'Ctrl+C            Stop watching (mid-turn), or quit (idle)',
  'F1 / Ctrl+G       Show this help; Tab, Shift+Tab, or Esc closes it',
  '                  (Ctrl+G works even where F1 is intercepted by the',
  '                  OS or terminal — e.g. bound to brightness on Macs)',
  '',
  'On the company roster:',
  '  Up / Down       Move the highlight (cycles across Roles and Tasks)',
  '  [ / ]           Jump to the previous/next list (Roles, Tasks)',
  '  Enter           Start a chat with the highlighted role, or open the',
  '                  highlighted task',
  '  r               Refresh the role list',
  '  n               Open the initiate-task form',
  '',
  'On a task panel:',
  '  Up / Down       Move the highlight (skips not-yet-begun assignments)',
  '  Enter           Open the highlighted (begun) assignment',
  '  c               Cancel the task (while it is running)',
  '  s               Start the task (while it is ready)',
  '',
  'On the initiate-task form:',
  '  Up / Down       Move the highlight',
  '  Enter           Edit the prompt/add a filename, choose the highlighted',
  '                  role, toggle "Start immediately", or submit',
  '  d               Remove the highlighted expected-output filename',
  '  (while editing) Type to enter text; Backspace deletes; Enter commits',
  '',
  'On a talkable tab:',
  '  Enter           Send the message',
  '  Alt+Enter       Insert a newline',
  '  PgUp / PgDn     Scroll the scrollback',
  "  'exit' / 'quit' Type either to end the whole session",
];
