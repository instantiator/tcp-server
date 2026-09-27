import { describe, expect, it, vi } from 'vitest';
import type { Scene } from 'phaser';
import type { OfficeLabel } from '../TcpPhaserEventBus';
import { LabelLayer } from './LabelLayer';

/** A stand-in Phaser text: records its text, position, visibility and whether it was destroyed. */
function fakeText(initial: string) {
  const text = {
    text: initial,
    x: 0,
    y: 0,
    visible: true,
    destroyed: false,
    setText: vi.fn((next: string) => {
      text.text = next;
      return text;
    }),
    setOrigin: vi.fn(() => text),
    setDepth: vi.fn(() => text),
    setPosition: vi.fn((x: number, y: number) => {
      text.x = x;
      text.y = y;
      return text;
    }),
    setVisible: vi.fn((visible: boolean) => {
      text.visible = visible;
      return text;
    }),
    destroy: vi.fn(() => {
      text.destroyed = true;
    }),
  };
  return text;
}

function fakeScene() {
  const made: ReturnType<typeof fakeText>[] = [];
  const scene = {
    add: {
      text: vi.fn((_x: number, _y: number, content: string) => {
        const text = fakeText(content);
        made.push(text);
        return text;
      }),
    },
  } as unknown as Scene;
  return { scene, made };
}

const tileLabel = (id: string, text: string): OfficeLabel => ({
  id,
  text,
  anchor: { kind: 'tile', tile: { x: 1, y: 1 } },
});

describe('LabelLayer', () => {
  it('adds, edits in place and removes labels by id', () => {
    const { scene, made } = fakeScene();
    const layer = new LabelLayer(scene);

    layer.sync([tileLabel('a', 'One'), tileLabel('b', 'Two')]);
    expect(made).toHaveLength(2);

    layer.sync([tileLabel('a', 'One, renamed')]);
    expect(made).toHaveLength(2); // edited, not recreated
    expect(made[0]?.text).toBe('One, renamed');
    expect(made[1]?.destroyed).toBe(true);
  });

  it('moves an avatar label with its avatar, and hides it while the avatar has no position', () => {
    const { scene, made } = fakeScene();
    const layer = new LabelLayer(scene);
    layer.sync([
      {
        id: 'avatar:x',
        text: 'Agent',
        anchor: { kind: 'avatar', avatarId: 'x' },
      },
    ]);

    layer.follow(() => ({ x: 2, y: 0 }));
    const first = { x: made[0]?.x, y: made[0]?.y };
    layer.follow(() => ({ x: 3, y: 0 }));
    expect(made[0]?.x).not.toBe(first.x);

    layer.follow(() => undefined);
    expect(made[0]?.visible).toBe(false);
  });

  it('destroys every label on destroy', () => {
    const { scene, made } = fakeScene();
    const layer = new LabelLayer(scene);
    layer.sync([tileLabel('a', 'One')]);
    layer.destroy();
    expect(made[0]?.destroyed).toBe(true);
  });
});
