import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Scene } from 'phaser';
import { emitTcpEvent } from '../TcpPhaserEventBus';
import { DRAG_THRESHOLD_PX } from './dragPan';
import { ThoughtBubbleLayer, bubbleParts } from './ThoughtBubbleLayer';

vi.mock('../TcpPhaserEventBus', () => ({ emitTcpEvent: vi.fn() }));

/** The pointer fields a bubble's click handler reads. */
interface FakePointer {
  readonly getDistance: () => number;
}

/** A stand-in Phaser game object: records visibility, position and handlers. */
function fakeObject() {
  const handlers = new Map<string, (pointer: FakePointer) => void>();
  const object = {
    visible: true,
    destroyed: false,
    x: 0,
    y: 0,
    handlers,
    setStrokeStyle: vi.fn(() => object),
    setInteractive: vi.fn(() => object),
    setDepth: vi.fn(() => object),
    setVisible: vi.fn((visible: boolean) => {
      object.visible = visible;
      return object;
    }),
    setPosition: vi.fn((x: number, y: number) => {
      object.x = x;
      object.y = y;
      return object;
    }),
    on: vi.fn((event: string, fn: (pointer: FakePointer) => void) => {
      handlers.set(event, fn);
      return object;
    }),
    destroy: vi.fn(() => {
      object.destroyed = true;
    }),
  };
  return object;
}

type FakeObject = ReturnType<typeof fakeObject>;

/** A scene whose bubbles are recorded as their parts, in the order made. */
function fakeScene() {
  const containers: FakeObject[] = [];
  const parts: FakeObject[][] = [];
  const zones: FakeObject[] = [];
  let pending: FakeObject[] = [];
  const make = () => {
    const object = fakeObject();
    pending.push(object);
    return object;
  };
  const scene = {
    add: {
      circle: vi.fn(make),
      ellipse: vi.fn(make),
      zone: vi.fn(() => {
        const zone = fakeObject();
        zones.push(zone);
        return zone;
      }),
      container: vi.fn(() => {
        const container = fakeObject();
        containers.push(container);
        parts.push(pending);
        pending = [];
        return container;
      }),
    },
  } as unknown as Scene;
  return { scene, containers, parts, zones };
}

const visibility = (parts: readonly FakeObject[]) =>
  parts.map((part) => part.visible);

const AT_ORIGIN = () => ({ x: 0, y: 0 });

describe('bubbleParts', () => {
  it('shows the small dot, then the middle one, then the cloud, holds, then clears', () => {
    const at = (step: number) => bubbleParts(step * 400, false);

    expect(at(0)).toEqual({ small: true, middle: false, cloud: false });
    expect(at(1)).toEqual({ small: true, middle: true, cloud: false });
    expect(at(2)).toEqual({ small: true, middle: true, cloud: true });
    expect(at(3)).toEqual({ small: true, middle: true, cloud: true });
    expect(at(4)).toEqual({ small: false, middle: false, cloud: false });
    expect(at(5)).toEqual(at(0));
  });

  it('shows the whole bubble, still, under reduced motion', () => {
    for (const time of [0, 400, 1600, 12345]) {
      expect(bubbleParts(time, true)).toEqual({
        small: true,
        middle: true,
        cloud: true,
      });
    }
  });
});

describe('ThoughtBubbleLayer', () => {
  beforeEach(() => {
    vi.mocked(emitTcpEvent).mockClear();
  });

  it('keeps one bubble per thinking avatar, and removes a bubble whose agent stops', () => {
    const { scene, containers } = fakeScene();
    const layer = new ThoughtBubbleLayer(scene);

    layer.sync([
      { avatarId: 'a1', agentId: 'agent-1' },
      { avatarId: 'a2', agentId: 'agent-2' },
    ]);
    layer.sync([{ avatarId: 'a1', agentId: 'agent-1' }]);

    expect(containers).toHaveLength(2);
    expect(containers[0]?.destroyed).toBe(false);
    expect(containers[1]?.destroyed).toBe(true);
  });

  it("follows its avatar and animates by the moment's step", () => {
    const { scene, containers, parts } = fakeScene();
    const layer = new ThoughtBubbleLayer(scene);
    layer.sync([{ avatarId: 'a1', agentId: 'agent-1' }]);

    layer.update(400, AT_ORIGIN, false);
    expect(visibility(parts[0] ?? [])).toEqual([true, true, false]);

    layer.update(1600, AT_ORIGIN, false);
    expect(visibility(parts[0] ?? [])).toEqual([false, false, false]);

    layer.update(1600, AT_ORIGIN, true);
    expect(visibility(parts[0] ?? [])).toEqual([true, true, true]);

    layer.update(0, () => undefined, false);
    expect(containers[0]?.visible).toBe(false);
  });

  it('asks to listen in on its agent when clicked, but not when dragged', () => {
    const { scene, zones } = fakeScene();
    const layer = new ThoughtBubbleLayer(scene);
    layer.sync([{ avatarId: 'a1', agentId: 'agent-1' }]);
    const release = zones[0]?.handlers.get('pointerup');

    release?.({ getDistance: () => DRAG_THRESHOLD_PX });
    expect(emitTcpEvent).not.toHaveBeenCalled();

    release?.({ getDistance: () => 0 });
    expect(emitTcpEvent).toHaveBeenCalledWith({
      event: 'listen-in',
      value: { agentId: 'agent-1' },
    });
  });

  it('destroys every bubble with the layer', () => {
    const { scene, containers } = fakeScene();
    const layer = new ThoughtBubbleLayer(scene);
    layer.sync([{ avatarId: 'a1', agentId: 'agent-1' }]);

    layer.destroy();

    expect(containers[0]?.destroyed).toBe(true);
  });
});
