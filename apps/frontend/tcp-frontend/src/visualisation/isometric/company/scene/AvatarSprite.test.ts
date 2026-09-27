import { describe, expect, it, vi } from 'vitest';
import type { Scene } from 'phaser';
import { AvatarSprite } from './AvatarSprite';

vi.mock('../TcpPhaserEventBus', () => ({ emitTcpEvent: vi.fn() }));

/** A stand-in game object: records visibility and accepts the calls the sprite makes. */
function fakeObject() {
  const object = {
    visible: true,
    setVisible: vi.fn((visible: boolean) => {
      object.visible = visible;
      return object;
    }),
    setPosition: vi.fn(() => object),
    setDepth: vi.fn(() => object),
    setInteractive: vi.fn(() => object),
    on: vi.fn(() => object),
    destroy: vi.fn(),
  };
  return object;
}

/** A scene whose `add` factories hand back fake objects, remembering what was made. */
function fakeScene() {
  const made = { isobox: 0, circle: 0 };
  const isoboxes: ReturnType<typeof fakeObject>[] = [];
  const scene = {
    add: {
      isobox: vi.fn(() => {
        made.isobox += 1;
        const box = fakeObject();
        isoboxes.push(box);
        return box;
      }),
      circle: vi.fn(() => {
        made.circle += 1;
        return fakeObject();
      }),
      container: vi.fn(() => fakeObject()),
      zone: vi.fn(() => fakeObject()),
    },
  };
  return { scene: scene as unknown as Scene, made, isoboxes };
}

describe('AvatarSprite', () => {
  it('draws a role as a book, with no head and no floor ring', () => {
    const { scene, made } = fakeScene();
    new AvatarSprite(scene, 'role:r1', 'role', 'r1', { x: 1, y: 1 });
    expect(made.circle).toBe(0);
    expect(made.isobox).toBe(2); // the cover and its pages
  });

  it('draws an agent with a head, and hides its carried book until it has its role', () => {
    const { scene, made, isoboxes } = fakeScene();
    const sprite = new AvatarSprite(scene, 'agent-avatar:1', 'agent', 'r1', {
      x: 1,
      y: 1,
    });
    expect(made.circle).toBe(1);
    const carried = isoboxes[0];
    expect(carried?.visible).toBe(false);

    sprite.setHasRole(true);
    expect(carried?.visible).toBe(true);

    sprite.setHasRole(false);
    expect(carried?.visible).toBe(false);
  });
});
