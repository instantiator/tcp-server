import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Scene } from 'phaser';
import { emitTcpEvent } from '../TcpPhaserEventBus';
import type { HoverTarget } from '../TcpPhaserEventBus';
import { DRAG_THRESHOLD_PX } from './dragPan';
import { createHitZone } from './hitZone';

vi.mock('../TcpPhaserEventBus', () => ({ emitTcpEvent: vi.fn() }));

/** The pointer fields a zone's handlers read. */
interface FakePointer {
  readonly x: number;
  readonly y: number;
  readonly getDistance?: () => number;
}

/** A press released where it started: a click. */
const CLICK: FakePointer = { x: 0, y: 0, getDistance: () => 0 };
/** A press released at the drag threshold: a drag, not a click (005.01). */
const DRAG: FakePointer = {
  x: 0,
  y: 0,
  getDistance: () => DRAG_THRESHOLD_PX,
};

/** A scene whose zone records its handlers, so a test can fire them. */
function sceneWithZone() {
  const handlers = new Map<string, (pointer?: FakePointer) => void>();
  const zone = {
    setInteractive: vi.fn(() => zone),
    on: vi.fn((event: string, fn: (pointer?: FakePointer) => void) => {
      handlers.set(event, fn);
      return zone;
    }),
  };
  const scene = { add: { zone: vi.fn(() => zone) } } as unknown as Scene;
  return { scene, handlers };
}

describe('createHitZone', () => {
  beforeEach(() => {
    vi.mocked(emitTcpEvent).mockClear();
  });

  it('selects a selectable target on a click', () => {
    const { scene, handlers } = sceneWithZone();
    const target: HoverTarget = { kind: 'task', id: 'task-1' };
    createHitZone(scene, 0, 0, 10, 10, () => target);

    handlers.get('pointerup')?.(CLICK);

    expect(emitTcpEvent).toHaveBeenCalledWith({
      event: 'select',
      value: target,
    });
  });

  it('selects nothing when the press was a drag, which pans instead', () => {
    const { scene, handlers } = sceneWithZone();
    const target: HoverTarget = { kind: 'task', id: 'task-1' };
    createHitZone(scene, 0, 0, 10, 10, () => target);

    handlers.get('pointerup')?.(DRAG);

    expect(emitTcpEvent).not.toHaveBeenCalled();
  });

  it('hovers and selects the archive bookshelf zone, which carries no id', () => {
    // The bookshelf's zone (`buildArchiveZone` in TcpCompanyScene) is built
    // exactly this way: `{kind:'archive'}` is neither `furniture` nor `room`,
    // so it is selectable like a task or role zone, while still emitting a
    // `hover` first — the tooltip that shows on hover is unaffected.
    const { scene, handlers } = sceneWithZone();
    const target: HoverTarget = { kind: 'archive' };
    createHitZone(scene, 0, 0, 10, 10, () => target);

    handlers.get('pointerover')?.({ x: 5, y: 6 });
    handlers.get('pointerup')?.(CLICK);

    expect(emitTcpEvent).toHaveBeenCalledWith({
      event: 'hover',
      value: { target, x: 5, y: 6 },
    });
    expect(emitTcpEvent).toHaveBeenCalledWith({
      event: 'select',
      value: target,
    });
  });

  it.each([
    { kind: 'furniture', id: 'rec:sofa:0' },
    { kind: 'room', id: 'mail' },
    { kind: 'completed', id: 'task-1' },
  ] as const)('only hovers $kind: a click selects nothing', (target) => {
    const { scene, handlers } = sceneWithZone();
    createHitZone(scene, 0, 0, 10, 10, () => target);

    handlers.get('pointerover')?.({ x: 3, y: 4 });
    handlers.get('pointerup')?.(CLICK);

    expect(emitTcpEvent).toHaveBeenCalledWith({
      event: 'hover',
      value: { target, x: 3, y: 4 },
    });
    expect(emitTcpEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: 'select' }),
    );
  });
});
