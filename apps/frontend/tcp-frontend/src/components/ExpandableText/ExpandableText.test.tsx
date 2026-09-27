import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { t } from '../../strings';
import { expectNoA11yViolations } from '../../test-support/axe';
import { ExpandableText } from './ExpandableText';
import { EXCERPT_LENGTH, excerptOf, shortened } from './excerpt';

const SHORT = 'Check last week’s invoices';
const LONG =
  'Investigate the ledger discrepancy reported in the September close, tracing every journal entry back to the source document that raised it, and write up what you find for the finance team before the audit begins.';
const NO_SPACES = 'x'.repeat(EXCERPT_LENGTH + 20);

const EXPAND = 'Show the full prompt';
const COLLAPSE = 'Show less of the prompt';

describe('excerptOf', () => {
  it('cuts back to the end of the last whole word', () => {
    const excerpt = excerptOf(LONG);
    expect(excerpt.length).toBeLessThanOrEqual(EXCERPT_LENGTH);
    expect(LONG.startsWith(excerpt)).toBe(true);
    expect(LONG.charAt(excerpt.length)).toBe(' ');
  });

  it('clips mid-word when there is no word boundary to back off to', () => {
    expect(excerptOf(NO_SPACES)).toHaveLength(EXCERPT_LENGTH);
  });
});

describe('shortened', () => {
  it('leaves short text alone and marks a clipped one as unfinished', () => {
    expect(shortened(SHORT)).toBe(SHORT);
    expect(shortened(LONG)).toBe(
      t('expandableText.truncated', { excerpt: excerptOf(LONG) }),
    );
  });
});

describe('ExpandableText', () => {
  it('shows short text whole, with no control', () => {
    render(
      <ExpandableText
        text={SHORT}
        expandLabel={EXPAND}
        collapseLabel={COLLAPSE}
      />,
    );
    expect(screen.getByText(SHORT)).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  describe.each(['labelled', 'ellipsis'] as const)(
    'the %s variant',
    (variant) => {
      it('keeps the rest of a long text out of the DOM until expanded, then collapses again', async () => {
        render(
          <ExpandableText
            text={LONG}
            variant={variant}
            expandLabel={EXPAND}
            collapseLabel={COLLAPSE}
          />,
        );
        expect(screen.queryByText(LONG)).not.toBeInTheDocument();

        const control = screen.getByRole('button', { name: EXPAND });
        expect(control).toHaveAttribute('aria-expanded', 'false');
        await userEvent.click(control);

        expect(screen.getByText(LONG)).toBeInTheDocument();
        const collapse = screen.getByRole('button', { name: COLLAPSE });
        expect(collapse).toHaveAttribute('aria-expanded', 'true');

        await userEvent.click(collapse);
        expect(screen.queryByText(LONG)).not.toBeInTheDocument();
      });

      it('has no accessibility violations, collapsed or expanded', async () => {
        const { container } = render(
          <ExpandableText
            text={LONG}
            variant={variant}
            expandLabel={EXPAND}
            collapseLabel={COLLAPSE}
          />,
        );
        await expectNoA11yViolations(container);
        await userEvent.click(screen.getByRole('button', { name: EXPAND }));
        await expectNoA11yViolations(container);
      });
    },
  );

  it('shows a compact "…" in the ellipsis variant, named in full', () => {
    render(
      <ExpandableText
        text={LONG}
        variant="ellipsis"
        expandLabel={EXPAND}
        collapseLabel={COLLAPSE}
      />,
    );
    expect(screen.getByRole('button', { name: EXPAND })).toHaveTextContent('…');
  });
});
