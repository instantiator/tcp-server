import type { ReactNode } from 'react';

export interface TrayPanelProps {
  readonly headingId: string;
  readonly heading: ReactNode;
  /**
   * A status icon before the heading; it must carry its own name. Outside the
   * `h2`, so the heading — and the tray landmark it names — stays "Task 003"
   * rather than taking on a status that changes.
   */
  readonly icon?: ReactNode;
  /** Small icon buttons for what the user can do with this entity. */
  readonly actions?: ReactNode;
  /** The entity's description, usually an `ExpandableText` with `variant="icon"`. */
  readonly description?: ReactNode;
  /** The panel's own content, which scrolls under the fixed parts. */
  readonly children?: ReactNode;
}

/**
 * The layout every office tray panel shares (000.06.03): a title bar (the
 * tray puts its close button there), then a fixed section of actions and the
 * description, then a body that scrolls. The tray's Follow button floats at
 * the bottom right.
 *
 * Fixed and scrolling regions are CSS only, so DOM order — and with it
 * reading and tab order — is title, actions, description, body (ADR-027).
 * An expanded description can take the whole tray and then scrolls itself,
 * its collapse button stuck to its bottom edge.
 */
export const TrayPanel = ({
  headingId,
  heading,
  icon,
  actions,
  description,
  children,
}: TrayPanelProps) => (
  <>
    <div className="tray-panel__title">
      {icon}
      {/* Focusable by script only, so focus has somewhere to go when a
          control in the panel below disappears. */}
      <h2 id={headingId} tabIndex={-1}>
        {heading}
      </h2>
    </div>
    {(actions !== undefined || description !== undefined) && (
      <div className="tray-panel__fixed">
        {actions !== undefined && (
          <div className="tray-panel__actions">{actions}</div>
        )}
        {description !== undefined && (
          <div className="tray-panel__description">{description}</div>
        )}
      </div>
    )}
    <div className="tray-panel__body">{children}</div>
  </>
);
