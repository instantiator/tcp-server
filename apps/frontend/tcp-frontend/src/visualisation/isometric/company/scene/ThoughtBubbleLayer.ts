import type { GameObjects, Input, Scene } from 'phaser';
import { tileToScreen } from '../motion/iso';
import { emitTcpEvent } from '../TcpPhaserEventBus';
import type { Tile } from '../world/types';
import { isClick } from './dragPan';
import { THOUGHT_BUBBLE_COLOUR, THOUGHT_BUBBLE_OUTLINE } from './palette';

/** How long each step of the bubble's animation lasts, in milliseconds. */
const STEP_MS = 400;

/**
 * Which parts of the bubble show at each step: the small dot, then the middle
 * dot, then the cloud, a held beat with everything up, then a blank beat
 * before it starts again.
 */
const STEPS = [
  { small: true, middle: false, cloud: false },
  { small: true, middle: true, cloud: false },
  { small: true, middle: true, cloud: true },
  { small: true, middle: true, cloud: true },
  { small: false, middle: false, cloud: false },
] as const;

/** Every part shown: the bubble under reduced motion, which never animates. */
const STILL = STEPS[2];

/** Which parts of a thought bubble show at `timeMs`. */
export const bubbleParts = (
  timeMs: number,
  reducedMotion: boolean,
): (typeof STEPS)[number] =>
  reducedMotion ? STILL : STEPS[Math.floor(timeMs / STEP_MS) % STEPS.length];

/*
 * Offsets from the avatar's base tile point, in pixels. Up and to the right
 * of the head (whose top is at y -33), so the bubble never covers the role
 * book the agent carries above it (`CARRIED_BOOK_Y` -44, centred on x 0).
 */
const SMALL = { x: 10, y: -38, radius: 2 };
const MIDDLE = { x: 15, y: -45, radius: 3 };
const CLOUD = { x: 27, y: -57, width: 24, height: 15 };
/** Above every avatar and piece of furniture, and just under the labels. */
const BUBBLE_DEPTH = 999_999;

interface Bubble {
  readonly agentId: string;
  readonly container: GameObjects.Container;
  readonly small: GameObjects.Arc;
  readonly middle: GameObjects.Arc;
  readonly cloud: GameObjects.Ellipse;
}

/** A thinking agent's avatar, as the layer needs it. */
export interface ThinkingAvatar {
  readonly avatarId: string;
  readonly agentId: string;
}

/**
 * Thought bubbles over the avatars of agents that are working (005.01): two
 * dots rising from the head, then a cloud, cleared and drawn again in a loop.
 * Clicking the cloud emits `listen-in`, so React opens that agent's chat
 * read-only.
 *
 * Pointer-only, like every hit zone on the canvas. The keyboard route to the
 * same chat is the "Show details for…" picker, then the agent's tray, then
 * its "Listen in" button.
 */
export class ThoughtBubbleLayer {
  private readonly bubbles = new Map<string, Bubble>();

  constructor(private readonly scene: Scene) {}

  /** Keeps one bubble per thinking avatar, by avatar id. */
  sync(thinking: readonly ThinkingAvatar[]): void {
    const seen = new Set<string>();
    for (const { avatarId, agentId } of thinking) {
      seen.add(avatarId);
      if (!this.bubbles.has(avatarId)) {
        this.bubbles.set(avatarId, this.create(agentId));
      }
    }
    for (const [avatarId, bubble] of this.bubbles) {
      if (!seen.has(avatarId)) {
        bubble.container.destroy();
        this.bubbles.delete(avatarId);
      }
    }
  }

  /** Moves each bubble to its avatar and shows this moment's step of the animation. */
  update(
    timeMs: number,
    positionOf: (avatarId: string) => Tile | undefined,
    reducedMotion: boolean,
  ): void {
    const parts = bubbleParts(timeMs, reducedMotion);
    for (const [avatarId, bubble] of this.bubbles) {
      const position = positionOf(avatarId);
      bubble.container.setVisible(position !== undefined);
      if (position === undefined) {
        continue;
      }
      const { x, y } = tileToScreen(position);
      bubble.container.setPosition(x, y);
      bubble.small.setVisible(parts.small);
      bubble.middle.setVisible(parts.middle);
      bubble.cloud.setVisible(parts.cloud);
    }
  }

  destroy(): void {
    this.bubbles.forEach((bubble) => bubble.container.destroy());
    this.bubbles.clear();
  }

  private create(agentId: string): Bubble {
    const { add } = this.scene;
    const small = add
      .circle(SMALL.x, SMALL.y, SMALL.radius, THOUGHT_BUBBLE_COLOUR)
      .setStrokeStyle(1, THOUGHT_BUBBLE_OUTLINE);
    const middle = add
      .circle(MIDDLE.x, MIDDLE.y, MIDDLE.radius, THOUGHT_BUBBLE_COLOUR)
      .setStrokeStyle(1, THOUGHT_BUBBLE_OUTLINE);
    const cloud = add
      .ellipse(
        CLOUD.x,
        CLOUD.y,
        CLOUD.width,
        CLOUD.height,
        THOUGHT_BUBBLE_COLOUR,
      )
      .setStrokeStyle(1, THOUGHT_BUBBLE_OUTLINE);
    // Covers the whole bubble, not just the cloud, so it can be clicked at
    // any step of the animation, including the blank one.
    const zone = add
      .zone(CLOUD.x - 4, CLOUD.y + 6, CLOUD.width + 16, CLOUD.height + 26)
      .setInteractive({ useHandCursor: true });
    zone.on('pointerup', (pointer: Input.Pointer) => {
      if (isClick(pointer)) {
        emitTcpEvent({ event: 'listen-in', value: { agentId } });
      }
    });
    const container = add
      .container(0, 0, [small, middle, cloud, zone])
      .setDepth(BUBBLE_DEPTH);
    return { agentId, container, small, middle, cloud };
  }
}
