import { useId, useState } from 'react';
import { Button } from 'react-aria-components';
import { t } from '../../strings';
import './ExpandableText.css';
import { EXCERPT_LENGTH, excerptOf } from './excerpt';

export interface ExpandableTextProps {
  readonly text: string;
  /**
   * The control's accessible name while collapsed. Name what it reveals, so
   * several on one page are told apart (WCAG 2.4.6).
   */
  readonly expandLabel: string;
  /** The control's accessible name while expanded. */
  readonly collapseLabel: string;
  /**
   * `labelled` shows the labels as the control's text, under the paragraph.
   * `ellipsis` puts a compact "…" at the end of the excerpt instead, for
   * narrow places like the office view's tray; its accessible name is still
   * the full label.
   */
  readonly variant?: 'labelled' | 'ellipsis';
  readonly className?: string;
}

/**
 * A long text, clipped to an excerpt with a control that reveals the rest.
 *
 * The full text is **out of the DOM** until it is asked for, rather than
 * present and visually clipped: CSS truncation is invisible to a screen
 * reader, which would read the whole text regardless and lose the very
 * saving this exists to make. The excerpt is a real opening of the text, so
 * what is read and what is shown are the same thing.
 *
 * The control comes after the text it extends, the way a "read more" reads.
 * `aria-controls` states that relationship and `aria-expanded` carries the
 * state; the text simply grows, and nothing moves out from under the cursor
 * (ADR-027).
 */
export const ExpandableText = ({
  text,
  expandLabel,
  collapseLabel,
  variant = 'labelled',
  className,
}: ExpandableTextProps) => {
  const [expanded, setExpanded] = useState(false);
  const textId = useId();

  // Nothing to expand: a control over text that already fits is a tab stop
  // that reveals nothing.
  if (text.length <= EXCERPT_LENGTH) {
    return <p className={className}>{text}</p>;
  }

  const toggle = () => {
    setExpanded((open) => !open);
  };

  if (variant === 'ellipsis') {
    return (
      <p className={className}>
        <span id={textId}>{expanded ? text : excerptOf(text)}</span>{' '}
        <Button
          className="react-aria-Button expandable-text__toggle"
          aria-expanded={expanded}
          aria-controls={textId}
          aria-label={expanded ? collapseLabel : expandLabel}
          onPress={toggle}
        >
          {expanded ? t('expandableText.showLess') : '…'}
        </Button>
      </p>
    );
  }

  return (
    <>
      <p className={className} id={textId}>
        {expanded
          ? text
          : t('expandableText.truncated', { excerpt: excerptOf(text) })}
      </p>
      <Button
        className="react-aria-Button expandable-text__toggle"
        aria-expanded={expanded}
        aria-controls={textId}
        onPress={toggle}
      >
        {expanded ? collapseLabel : expandLabel}
      </Button>
    </>
  );
};
