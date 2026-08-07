import {
  CONTENT_TOP,
  contentHeight,
  HINT_ROWS,
  hasRoomForContent,
  inputFits,
  INPUT_ROWS,
  inputTop,
} from './tui-layout';

describe('hasRoomForContent', () => {
  it('is true once one row is free between the gap row and the hint bar', () => {
    expect(hasRoomForContent(80, CONTENT_TOP + HINT_ROWS + 1)).toBe(true);
  });

  it('is false when the hint bar would sit on the first content row', () => {
    expect(hasRoomForContent(80, CONTENT_TOP + HINT_ROWS)).toBe(false);
  });

  it('is false on a terminal too narrow for a heading and scrollbar column', () => {
    expect(hasRoomForContent(2, 24)).toBe(false);
    expect(hasRoomForContent(3, 24)).toBe(true);
  });
});

describe('inputFits', () => {
  it('needs the input rows to clear the content area entirely', () => {
    expect(inputFits(CONTENT_TOP + HINT_ROWS + INPUT_ROWS)).toBe(false);
    expect(inputFits(CONTENT_TOP + HINT_ROWS + INPUT_ROWS + 1)).toBe(true);
  });
});

describe('inputTop', () => {
  it('places the input box immediately above the hint bar', () => {
    expect(inputTop(24)).toBe(24 - HINT_ROWS - INPUT_ROWS);
  });
});

describe('contentHeight', () => {
  it('gives the pane everything but the chrome rows', () => {
    expect(contentHeight(24, false)).toBe(24 - CONTENT_TOP - HINT_ROWS);
  });

  it('gives up the input rows when an input box is shown', () => {
    expect(contentHeight(24, true)).toBe(
      24 - CONTENT_TOP - HINT_ROWS - INPUT_ROWS,
    );
  });

  it('never returns less than one row, however short the terminal', () => {
    expect(contentHeight(1, true)).toBe(1);
  });
});
