import { describe, expect, it } from 'vitest';
import {
  DRAG_THRESHOLD_PX,
  DragPan,
  isClick,
  type DragPointer,
} from './dragPan';

/** A pointer pressed at the origin and now at (`x`, `y`), last seen at `prev`. */
const pointerAt = (
  x: number,
  y: number,
  prev: { x: number; y: number } = { x: 0, y: 0 },
  isDown = true,
): DragPointer => ({
  isDown,
  x,
  y,
  downX: 0,
  downY: 0,
  prevPosition: prev,
  getDistance: () => Math.hypot(x, y),
});

describe('isClick', () => {
  it('counts a release under the threshold as a click', () => {
    expect(isClick(pointerAt(DRAG_THRESHOLD_PX - 1, 0))).toBe(true);
  });

  it('counts a release at or past the threshold as a drag', () => {
    expect(isClick(pointerAt(DRAG_THRESHOLD_PX, 0))).toBe(false);
  });
});

describe('DragPan', () => {
  it('pans nothing while the pointer stays within the click threshold', () => {
    const drag = new DragPan();

    expect(drag.move(pointerAt(3, 2), 1)).toBeNull();
    expect(drag.isDragging).toBe(false);
  });

  it('pans nothing while the button is up', () => {
    const drag = new DragPan();

    expect(drag.move(pointerAt(40, 0, { x: 0, y: 0 }, false), 1)).toBeNull();
  });

  it('catches up the whole distance on crossing the threshold, opposite the pointer', () => {
    const drag = new DragPan();

    expect(drag.move(pointerAt(10, -4, { x: 3, y: 0 }), 1)).toEqual({
      dx: -10,
      dy: 4,
    });
    expect(drag.isDragging).toBe(true);
  });

  it('then pans by each move since the last, scaled by zoom', () => {
    const drag = new DragPan();
    drag.move(pointerAt(10, 0), 2);

    expect(drag.move(pointerAt(14, 6, { x: 10, y: 0 }), 2)).toEqual({
      dx: -2,
      dy: -3,
    });
  });

  it('starts afresh after the drag ends', () => {
    const drag = new DragPan();
    drag.move(pointerAt(10, 0), 1);
    drag.end();

    expect(drag.isDragging).toBe(false);
    expect(drag.move(pointerAt(2, 0), 1)).toBeNull();
  });
});
