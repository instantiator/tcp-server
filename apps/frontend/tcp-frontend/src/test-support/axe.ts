// The component tier's accessibility assertion (ADR-026): every component test
// scans its rendered output with axe, so a structural regression fails the
// build rather than waiting for review.
//
// axe-core is used directly rather than through a matcher package —
// `vitest-axe` is 0.1.0, released against Vitest 0.x, and this is the whole of
// what it would provide.
import axe from 'axe-core';
import { expect } from 'vitest';

/**
 * Asserts the rendered tree has no axe violations, failing with the violated
 * rule ids and their descriptions rather than an opaque boolean.
 *
 * @param container The element to scan — Testing Library's `render` result
 *   `container`, or `document.body` for a component that portals out of it.
 */
export const expectNoA11yViolations = async (container: HTMLElement) => {
  const { violations } = await axe.run(container, {
    rules: {
      // jsdom has no layout engine and no canvas, so axe cannot measure
      // contrast here — it reports every check as "incomplete", never as a
      // pass. The browser tier's @axe-core/playwright scan covers it for real.
      'color-contrast': { enabled: false },
    },
  });

  expect(
    violations.map((v) => `${v.id}: ${v.help} (${v.nodes.length} nodes)`),
  ).toEqual([]);
};
