import { fitHints } from './tui-hints';

describe('fitHints', () => {
  it('joins hints with a middle dot', () => {
    expect(fitHints(['Enter send', 'Ctrl+C quit'], 80)).toBe(
      'Enter send · Ctrl+C quit',
    );
  });

  it('drops the least important hints first, never truncating mid-word', () => {
    expect(fitHints(['Enter send', 'Ctrl+C quit', 'Tab switch'], 24)).toBe(
      'Enter send · Ctrl+C quit',
    );
  });

  it('keeps nothing when even the first hint overflows', () => {
    expect(fitHints(['Enter send'], 5)).toBe('');
  });

  it('is empty for no hints at all', () => {
    expect(fitHints([], 80)).toBe('');
  });
});
