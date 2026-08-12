import type { ReactNode } from 'react';
import './EmptyState.css';

export interface EmptyStateProps {
  /** The heading. Already resolved through `t`. */
  readonly heading: string;
  /** Its level in the page's outline — the page owns the outline, not this. */
  readonly headingLevel?: 2 | 3 | 4;
  /** What has happened, and what to do about it. Not just "nothing here". */
  readonly children: ReactNode;
}

/**
 * A surface with nothing in it yet.
 *
 * **This announces nothing, ever**, and imports nothing from the announcer.
 * ADR-027 treats an empty state as ordinary content: it is reached by
 * browsing, and a heading is what makes it findable that way. Announcing it
 * would interrupt the user to describe the page they are already on.
 *
 * The heading level is the caller's, because the page owns its outline and a
 * component that hardcoded `h2` would break the sequence wherever it was
 * nested one level deeper.
 */
export const EmptyState = ({
  heading,
  headingLevel = 2,
  children,
}: EmptyStateProps) => {
  const Heading = `h${headingLevel}` as const;

  return (
    <div className="empty-state">
      <Heading className="empty-state__heading">{heading}</Heading>
      <div className="empty-state__body">{children}</div>
    </div>
  );
};
