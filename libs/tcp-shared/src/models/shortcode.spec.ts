import { buildAssignmentShortcode, formatShortcodeIndex } from './shortcode';

describe('formatShortcodeIndex', () => {
  it('pads to 3 digits', () => {
    expect(formatShortcodeIndex(0)).toBe('000');
    expect(formatShortcodeIndex(7)).toBe('007');
    expect(formatShortcodeIndex(42)).toBe('042');
  });

  it('does not truncate an index requiring more than 3 digits', () => {
    expect(formatShortcodeIndex(1234)).toBe('1234');
  });
});

describe('buildAssignmentShortcode', () => {
  it('builds a plan-mode shortcode at index 0', () => {
    expect(buildAssignmentShortcode('000', 'plan', 0)).toBe('000-000-plan');
  });

  it('builds an implement-mode shortcode from its plan index', () => {
    expect(buildAssignmentShortcode('000', 'implement', 1)).toBe(
      '000-001-implement',
    );
  });

  it("builds a qa-mode shortcode sharing its target implement step's plan index", () => {
    expect(buildAssignmentShortcode('000', 'qa', 1)).toBe('000-001-qa');
  });

  it('uses the task shortcode as given, without reformatting it', () => {
    expect(buildAssignmentShortcode('1234', 'finalise', 3)).toBe(
      '1234-003-finalise',
    );
  });
});
