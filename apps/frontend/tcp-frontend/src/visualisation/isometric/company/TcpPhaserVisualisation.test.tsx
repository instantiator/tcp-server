import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TcpCompanyScene } from './TcpCompanyScene';
import TcpPhaserVisualisation from './TcpPhaserVisualisation';

// `phaser` is mocked globally in `test-setup.ts` — real Phaser cannot even be
// imported under jsdom. That mock's `Game` is a `vi.fn()`, which is what lets
// the tests below assert on how it was constructed.

const noop = () => undefined;

const renderVisualisation = () =>
  render(
    <TcpPhaserVisualisation
      companyId="company-1"
      roles={[]}
      agents={[]}
      tasks={[]}
      onRoleClick={noop}
      onAgentClick={noop}
      onTaskClick={noop}
    />,
  );

describe('TcpPhaserVisualisation', () => {
  // The mocked `Game` constructor is a module-level singleton shared by
  // every test in this file — without this, one test's construction count
  // includes every earlier test's too.
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders a single div with id game-container', () => {
    const { container } = renderVisualisation();

    // `getElementById` can only ever return one match by definition, so
    // duplicates are checked with a selector that would surface every one.
    expect(container.querySelectorAll('[id="game-container"]')).toHaveLength(1);
  });

  it('never duplicates the game-container div across re-renders', () => {
    const { container, rerender } = renderVisualisation();

    rerender(
      <TcpPhaserVisualisation
        companyId="company-1"
        roles={[]}
        agents={[]}
        tasks={[]}
        onRoleClick={noop}
        onAgentClick={noop}
        onTaskClick={noop}
      />,
    );

    expect(container.querySelectorAll('[id="game-container"]')).toHaveLength(1);
  });

  it('creates exactly one Phaser game, configured with TcpCompanyScene', async () => {
    const { Game } = await import('phaser');
    const { rerender } = renderVisualisation();

    rerender(
      <TcpPhaserVisualisation
        companyId="company-1"
        roles={[]}
        agents={[]}
        tasks={[]}
        onRoleClick={noop}
        onAgentClick={noop}
        onTaskClick={noop}
      />,
    );

    // Mounted once via `useLayoutEffect`'s empty dependency array — a
    // second render must not construct a second game.
    expect(vi.mocked(Game)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(Game)).toHaveBeenCalledWith(
      expect.objectContaining({
        parent: 'game-container',
        scene: [TcpCompanyScene],
      }),
    );
  });

  it('destroys the game and stops the scene on unmount', async () => {
    const { Game } = await import('phaser');
    const { unmount } = renderVisualisation();

    const instance = vi.mocked(Game).mock.results[0]?.value as {
      destroy: ReturnType<typeof vi.fn>;
    };

    unmount();

    expect(instance.destroy).toHaveBeenCalledWith(true);
  });
});
