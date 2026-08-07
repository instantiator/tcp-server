import { virtual } from '@guidepup/virtual-screen-reader';
import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ANNOUNCE_THROTTLE_MS } from '../../announce/announcer';
import { expectNoA11yViolations } from '../../test-support/axe';
import { EmptyState } from './EmptyState';

const HEADING = 'No companies yet';
const BODY = 'Create one to get started.';

describe('EmptyState', () => {
  it('is findable by browsing, under a heading', () => {
    render(<EmptyState heading={HEADING}>{BODY}</EmptyState>);

    expect(
      screen.getByRole('heading', { level: 2, name: HEADING }),
    ).toBeInTheDocument();
    expect(screen.getByText(BODY)).toBeInTheDocument();
  });

  it('takes its heading level from the page that owns the outline', () => {
    render(
      <EmptyState heading={HEADING} headingLevel={3}>
        {BODY}
      </EmptyState>,
    );

    expect(
      screen.getByRole('heading', { level: 3, name: HEADING }),
    ).toBeInTheDocument();
  });

  describe('speech', () => {
    beforeEach(() => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
    });

    afterEach(async () => {
      await virtual.stop();
      vi.useRealTimers();
    });

    it('announces nothing at all', async () => {
      await virtual.start({ container: document.body });
      await virtual.clearSpokenPhraseLog();

      render(<EmptyState heading={HEADING}>{BODY}</EmptyState>);
      await vi.advanceTimersByTimeAsync(ANNOUNCE_THROTTLE_MS * 2);

      // ADR-027: an empty state is ordinary content, reached by browsing.
      // Announcing it would interrupt the user to describe where they are.
      expect(await virtual.spokenPhraseLog()).toEqual([]);
    });
  });

  it('has no accessibility violations', async () => {
    const { container } = render(
      <EmptyState heading={HEADING}>{BODY}</EmptyState>,
    );

    await expectNoA11yViolations(container);
  });
});
