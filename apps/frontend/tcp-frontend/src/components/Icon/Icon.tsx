import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Tooltip, TooltipTrigger } from 'react-aria-components';

/** An icon drawn inside a control or beside text. Decorative: the text or control carries the name. */
export const Icon = ({ icon: Glyph }: { readonly icon: LucideIcon }) => (
  <Glyph className="tcp-icon" aria-hidden="true" />
);

/**
 * A control whose face is only an icon, so its name is also shown as a
 * tooltip on hover or focus: a sighted user sees what the icon means, and
 * voice control and screen readers use the same words (WCAG 2.5.3).
 */
export const WithTooltip = ({
  label,
  portalContainer,
  children,
}: {
  readonly label: string;
  /**
   * Where the tooltip is portalled, when it must stay inside an element such
   * as the office view in full screen. The page body when omitted.
   */
  readonly portalContainer?: Element | undefined;
  readonly children: ReactNode;
}) => (
  <TooltipTrigger>
    {children}
    {/*
      `UNSTABLE_portalContainer` is deprecated in favour of react-aria's
      `UNSAFE_PortalProvider`, which react-aria-components doesn't re-export.
      Importing it from react-aria directly would need a second dependency
      pinned in step with the one react-aria-components pins, and it fails
      silently when they drift. This prop fails loudly, at compile time, if
      it is ever removed.
    */}
    <Tooltip
      className="react-aria-Tooltip"
      // eslint-disable-next-line @typescript-eslint/no-deprecated -- deliberate; see the comment above
      UNSTABLE_portalContainer={portalContainer}
    >
      {label}
    </Tooltip>
  </TooltipTrigger>
);
