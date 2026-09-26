import type { GameObjects, Input, Scene } from 'phaser';
import { emitTcpEvent } from '../TcpPhaserEventBus';
import type { SelectionTarget } from '../TcpPhaserEventBus';

/**
 * Wires one interactive zone to the bus: `hover` on over and move, `hover`
 * null on out, `select` on pointerdown. `getTarget` is read on every event
 * rather than captured once, so a caller can repoint an existing zone at a
 * new selection (an avatar sprite does this on every `world-changed`)
 * without recreating it.
 *
 * A zone's origin is its centre — `add.zone`'s default — so `x`/`y` must be
 * the centre of the object's visible body, not its base tile, or the hit
 * area sits over the wrong part of the isometric shape.
 */
export function createHitZone(
  scene: Scene,
  x: number,
  y: number,
  width: number,
  height: number,
  getTarget: () => SelectionTarget,
): GameObjects.Zone {
  const zone = scene.add
    .zone(x, y, width, height)
    .setInteractive({ useHandCursor: true });

  const hoverAt = (pointer: Input.Pointer): void => {
    emitTcpEvent({
      event: 'hover',
      value: { target: getTarget(), x: pointer.x, y: pointer.y },
    });
  };

  zone.on('pointerover', hoverAt);
  zone.on('pointermove', hoverAt);
  zone.on('pointerout', () => {
    emitTcpEvent({ event: 'hover', value: null });
  });
  zone.on('pointerdown', () => {
    emitTcpEvent({ event: 'select', value: getTarget() });
  });

  return zone;
}
