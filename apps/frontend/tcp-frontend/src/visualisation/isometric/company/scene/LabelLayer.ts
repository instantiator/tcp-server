import type { GameObjects, Scene } from 'phaser';
import { tileToScreen } from '../motion/iso';
import type { OfficeLabel } from '../TcpPhaserEventBus';
import type { Tile } from '../world/types';
import { LABEL_STYLE } from './palette';

/** How far above its anchor a label sits, in pixels: clear of a figure's head, or of furniture. */
const AVATAR_LABEL_LIFT = 44;
const TILE_LABEL_LIFT = 36;
/** Above every avatar and piece of furniture, whose depth is their screen `y`. */
const LABEL_DEPTH = 1_000_000;

/**
 * The canvas labels, kept in step with `labels-changed` by id so a label
 * whose text changes is edited in place rather than recreated. A tile label
 * is placed once; an avatar label follows its avatar every frame.
 */
// ponytail: labels aren't laid out to avoid each other; add collision nudging if crowded rooms become unreadable
export class LabelLayer {
  private readonly texts = new Map<string, GameObjects.Text>();
  private labels: readonly OfficeLabel[] = [];

  constructor(private readonly scene: Scene) {}

  sync(labels: readonly OfficeLabel[]): void {
    this.labels = labels;
    const seen = new Set<string>();

    for (const label of labels) {
      seen.add(label.id);
      let text = this.texts.get(label.id);
      if (text === undefined) {
        text = this.scene.add.text(0, 0, label.text, LABEL_STYLE);
        text.setOrigin(0.5, 1);
        text.setDepth(LABEL_DEPTH);
        this.texts.set(label.id, text);
      } else if (text.text !== label.text) {
        text.setText(label.text);
      }
      if (label.anchor.kind === 'tile') {
        place(text, label.anchor.tile, TILE_LABEL_LIFT);
      }
    }

    for (const [id, text] of this.texts) {
      if (!seen.has(id)) {
        text.destroy();
        this.texts.delete(id);
      }
    }
  }

  /** Moves each avatar label to wherever its avatar is now; hidden while it has no position. */
  follow(positionOf: (avatarId: string) => Tile | undefined): void {
    for (const label of this.labels) {
      if (label.anchor.kind !== 'avatar') {
        continue;
      }
      const text = this.texts.get(label.id);
      const position = positionOf(label.anchor.avatarId);
      if (text === undefined) {
        continue;
      }
      text.setVisible(position !== undefined);
      if (position !== undefined) {
        place(text, position, AVATAR_LABEL_LIFT);
      }
    }
  }

  destroy(): void {
    this.texts.forEach((text) => text.destroy());
    this.texts.clear();
    this.labels = [];
  }
}

function place(text: GameObjects.Text, tile: Tile, lift: number): void {
  const { x, y } = tileToScreen(tile);
  text.setPosition(x, y - lift);
}
