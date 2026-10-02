/**
 * How far, in screen pixels, a pointer may move between press and release and
 * still count as a click. Past it, the press is a drag that pans the camera
 * and selects nothing — so a drag that starts on an avatar doesn't open its
 * tray. Small enough that a deliberate drag crosses it at once, large enough
 * that a hand's tremor during a click doesn't.
 */
export const DRAG_THRESHOLD_PX = 6;

/** What `dragPan` needs to know of a Phaser pointer. */
export interface DragPointer {
  readonly isDown: boolean;
  readonly x: number;
  readonly y: number;
  readonly downX: number;
  readonly downY: number;
  readonly prevPosition: { readonly x: number; readonly y: number };
  /** Distance from where the press started to where the pointer is now. */
  getDistance(): number;
}

/** Whether a press released here was a click, not the end of a drag. */
export const isClick = (pointer: Pick<DragPointer, 'getDistance'>): boolean =>
  pointer.getDistance() < DRAG_THRESHOLD_PX;

/**
 * Tracks one press-and-drag across pointer moves, turning each move into the
 * camera scroll that keeps the world under the pointer.
 */
export class DragPan {
  private dragging = false;

  /**
   * The scroll to apply for this move, or `null` when it pans nothing: the
   * button is up, or the pointer hasn't yet left the click threshold. On the
   * move that crosses the threshold, the whole distance since the press is
   * applied at once, so the world catches up with the pointer rather than
   * lagging it by the threshold for the rest of the drag.
   *
   * Scroll moves opposite to the pointer: dragging the world left shows
   * what lies to its right. `zoom` converts screen pixels to world units.
   */
  move(
    pointer: DragPointer,
    zoom: number,
  ): { readonly dx: number; readonly dy: number } | null {
    if (!pointer.isDown) {
      this.dragging = false;
      return null;
    }
    if (!this.dragging) {
      if (isClick(pointer)) {
        return null;
      }
      this.dragging = true;
      return {
        dx: (pointer.downX - pointer.x) / zoom,
        dy: (pointer.downY - pointer.y) / zoom,
      };
    }
    return {
      dx: (pointer.prevPosition.x - pointer.x) / zoom,
      dy: (pointer.prevPosition.y - pointer.y) / zoom,
    };
  }

  /** Whether a drag is under way, for the grabbing cursor. */
  get isDragging(): boolean {
    return this.dragging;
  }

  /** Ends the drag, on release or when the pointer leaves the canvas. */
  end(): void {
    this.dragging = false;
  }
}
