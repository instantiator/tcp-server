import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Scene } from 'phaser';
import { emitTcpEvent } from '../TcpPhaserEventBus';
import type { HoverTarget } from '../TcpPhaserEventBus';
import { createHitZone } from './hitZone';

vi.mock('../TcpPhaserEventBus', () => ({ emitTcpEvent: vi.fn() }));

/** A scene whose zone records its handlers, so a test can fire them. */
function sceneWithZone() {
  const handlers = new Map<
    string,
    (pointer?: { x: number; y: number }) => void
  >();
  const zone = {
    setInteractive: vi.fn(() => zone),
    on: vi.fn(
      (event: string, fn: (pointer?: { x: number; y: number }) => void) => {
        handlers.set(event, fn);
        return zone;
      },
    ),
  };
  const scene = { add: { zone: vi.fn(() => zone) } } as unknown as Scene;
  return { scene, handlers };
}

describe('createHitZone', () => {
  beforeEach(() => {
    vi.mocked(emitTcpEvent).mockClear();
  });

  it('selects a selectable target on pointerdown', () => {
    const { scene, handlers } = sceneWithZone();
    const target: HoverTarget = { kind: 'task', id: 'task-1' };
    createHitZone(scene, 0, 0, 10, 10, () => target);

    handlers.get('pointerdown')?.();

    expect(emitTcpEvent).toHaveBeenCalledWith({
      event: 'select',
      value: target,
    });
  });

  it.each([
    { kind: 'furniture', id: 'rec:sofa:0' },
    { kind: 'room', id: 'mail' },
  ] as const)('only hovers $kind: a click selects nothing', (target) => {
    const { scene, handlers } = sceneWithZone();
    createHitZone(scene, 0, 0, 10, 10, () => target);

    handlers.get('pointerover')?.({ x: 3, y: 4 });
    handlers.get('pointerdown')?.();

    expect(emitTcpEvent).toHaveBeenCalledWith({
      event: 'hover',
      value: { target, x: 3, y: 4 },
    });
    expect(emitTcpEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: 'select' }),
    );
  });
});
