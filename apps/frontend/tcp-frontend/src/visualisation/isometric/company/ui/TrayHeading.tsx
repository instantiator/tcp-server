import type { ReactNode } from 'react';

export interface TrayHeadingProps {
  readonly id: string;
  readonly children: ReactNode;
  /** The follow toggle, set beside the heading rather than elsewhere in the panel. */
  readonly action?: ReactNode;
}

/**
 * A tray panel's heading, with its action (the follow toggle) beside it. Each
 * `*Details` component renders its own heading through this, in every state
 * it has one for (loading, gone, loaded) — the action travels with it rather
 * than living at the tray's own level, so it reads next to whatever it acts
 * on regardless of which kind of selection is showing.
 */
export const TrayHeading = ({ id, children, action }: TrayHeadingProps) => (
  <div className="company-visualisation__tray-heading">
    {/* Focusable by script only, so focus has somewhere to go when a
        control in the panel below disappears. */}
    <h2 id={id} tabIndex={-1}>
      {children}
    </h2>
    {action}
  </div>
);
