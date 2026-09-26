import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TcpCompanyScene } from './scene/TcpCompanyScene';
import {
  emitTcpEvent,
  offTcpEvent,
  onTcpEvent,
  type SelectionTarget,
} from './TcpPhaserEventBus';
import TcpPhaserVisualisation from './TcpPhaserVisualisation';
import type { TcpPhaserVisualisationProps } from './TcpPhaserVisualisation';
import { createInitialWorld } from './world/layout';
import type { OfficeWorld, Tile } from './world/types';

// `phaser` is mocked globally in `test-setup.ts` — real Phaser cannot even be
// imported under jsdom. That mock's `Game` is a `vi.fn()`, which is what lets
// the tests below assert on how it was constructed. `TcpPhaserEventBus` is
// the real module: it has no Phaser import of its own, so the round trips
// below exercise the real bus underneath the mocked game.

const WORLD: OfficeWorld = createInitialWorld();
const OTHER_WORLD: OfficeWorld = {
  ...WORLD,
  layoutVersion: WORLD.layoutVersion + 1,
};

const renderVisualisation = (
  props: Partial<TcpPhaserVisualisationProps> = {},
) => render(<TcpPhaserVisualisation world={WORLD} {...props} />);

/**
 * `emitTcpEvent` always forwards its (usually absent) `context` as a second
 * positional argument, so a raw bus listener sees `(value, undefined)`
 * rather than just `(value)`. This reads only the value, so a test asserting
 * on it isn't coupled to that.
 */
const lastValue = (spy: ReturnType<typeof vi.fn>): unknown =>
  spy.mock.calls.at(-1)?.[0];

describe('TcpPhaserVisualisation', () => {
  // The mocked `Game` constructor is a module-level singleton shared by
  // every test in this file — without this, one test's construction count
  // includes every earlier test's too.
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders exactly one canvas div, including after a rerender', () => {
    const { container, rerender } = renderVisualisation();

    expect(
      container.querySelectorAll('.company-visualisation__canvas'),
    ).toHaveLength(1);

    rerender(<TcpPhaserVisualisation world={OTHER_WORLD} />);

    expect(
      container.querySelectorAll('.company-visualisation__canvas'),
    ).toHaveLength(1);
  });

  it('creates exactly one Phaser game under rerender, configured with the canvas div and TcpCompanyScene', async () => {
    const { Game, Scale } = await import('phaser');
    const { container, rerender } = renderVisualisation();

    rerender(<TcpPhaserVisualisation world={OTHER_WORLD} />);

    const canvas = container.querySelector('.company-visualisation__canvas');
    expect(vi.mocked(Game)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(Game)).toHaveBeenCalledWith(
      expect.objectContaining({
        parent: canvas,
        transparent: true,
        scale: { mode: Scale.RESIZE, width: '100%', height: '100%' },
        input: { keyboard: false },
        scene: [TcpCompanyScene],
      }),
    );
  });

  it('destroys the game on unmount', async () => {
    const { Game } = await import('phaser');
    const { unmount } = renderVisualisation();

    const instance = vi.mocked(Game).mock.results[0]?.value as {
      destroy: ReturnType<typeof vi.fn>;
    };

    unmount();

    expect(instance.destroy).toHaveBeenCalledWith(true);
  });

  it('emits world-changed, motion-preference and camera-follow when the scene announces it is ready', () => {
    renderVisualisation({ reducedMotion: true, followTarget: null });

    const onWorldChanged = vi.fn();
    const onMotionPreference = vi.fn();
    const onCameraFollow = vi.fn();
    onTcpEvent({ event: 'world-changed', fn: onWorldChanged });
    onTcpEvent({ event: 'motion-preference', fn: onMotionPreference });
    onTcpEvent({ event: 'camera-follow', fn: onCameraFollow });

    emitTcpEvent({ event: 'scene-ready', value: undefined });

    expect(lastValue(onWorldChanged)).toEqual(WORLD);
    expect(lastValue(onMotionPreference)).toEqual({ reduced: true });
    expect(lastValue(onCameraFollow)).toEqual(null);

    offTcpEvent({ event: 'world-changed', fn: onWorldChanged });
    offTcpEvent({ event: 'motion-preference', fn: onMotionPreference });
    offTcpEvent({ event: 'camera-follow', fn: onCameraFollow });
  });

  it('emits world-changed when the world prop changes', () => {
    const { rerender } = renderVisualisation();

    const onWorldChanged = vi.fn();
    onTcpEvent({ event: 'world-changed', fn: onWorldChanged });

    rerender(<TcpPhaserVisualisation world={OTHER_WORLD} />);

    expect(lastValue(onWorldChanged)).toEqual(OTHER_WORLD);

    offTcpEvent({ event: 'world-changed', fn: onWorldChanged });
  });

  describe('forwarding scene events to the latest callback', () => {
    it('forwards avatar-arrived', () => {
      const onAvatarArrived = vi.fn();
      renderVisualisation({ onAvatarArrived });

      const tile: Tile = { x: 1, y: 2 };
      emitTcpEvent({
        event: 'avatar-arrived',
        value: { avatarId: 'agent-avatar:1', tile },
      });

      expect(onAvatarArrived).toHaveBeenCalledWith('agent-avatar:1', tile);
    });

    it('forwards avatar-exited', () => {
      const onAvatarExited = vi.fn();
      renderVisualisation({ onAvatarExited });

      emitTcpEvent({
        event: 'avatar-exited',
        value: { avatarId: 'agent-avatar:1' },
      });

      expect(onAvatarExited).toHaveBeenCalledWith('agent-avatar:1');
    });

    it('forwards hover', () => {
      const onHover = vi.fn();
      renderVisualisation({ onHover });

      const hover = {
        target: { kind: 'role' as const, id: 'role-1' },
        x: 10,
        y: 20,
      };
      emitTcpEvent({ event: 'hover', value: hover });

      expect(onHover).toHaveBeenCalledWith(hover);

      emitTcpEvent({ event: 'hover', value: null });

      expect(onHover).toHaveBeenCalledWith(null);
    });

    it('forwards select', () => {
      const onSelect = vi.fn();
      renderVisualisation({ onSelect });

      const target: SelectionTarget = { kind: 'task', id: 'task-1' };
      emitTcpEvent({ event: 'select', value: target });

      expect(onSelect).toHaveBeenCalledWith(target);
    });

    it('forwards follow-stopped', () => {
      const onFollowStopped = vi.fn();
      renderVisualisation({ onFollowStopped });

      emitTcpEvent({ event: 'follow-stopped', value: undefined });

      expect(onFollowStopped).toHaveBeenCalledTimes(1);
    });

    it('calls the new callback and not the old one after a rerender', () => {
      const first = vi.fn();
      const second = vi.fn();
      const { rerender } = renderVisualisation({ onSelect: first });

      rerender(<TcpPhaserVisualisation world={WORLD} onSelect={second} />);

      const target: SelectionTarget = { kind: 'role', id: 'role-1' };
      emitTcpEvent({ event: 'select', value: target });

      expect(second).toHaveBeenCalledWith(target);
      expect(first).not.toHaveBeenCalled();
    });
  });

  describe('after unmount', () => {
    it('calls no callback and emits no world-changed for a late scene event', () => {
      const onAvatarArrived = vi.fn();
      const onWorldChanged = vi.fn();
      const { unmount } = renderVisualisation({ onAvatarArrived });
      onTcpEvent({ event: 'world-changed', fn: onWorldChanged });

      unmount();

      emitTcpEvent({
        event: 'avatar-arrived',
        value: { avatarId: 'agent-avatar:1', tile: { x: 0, y: 0 } },
      });
      emitTcpEvent({ event: 'scene-ready', value: undefined });

      expect(onAvatarArrived).not.toHaveBeenCalled();
      expect(onWorldChanged).not.toHaveBeenCalled();

      offTcpEvent({ event: 'world-changed', fn: onWorldChanged });
    });
  });
});
