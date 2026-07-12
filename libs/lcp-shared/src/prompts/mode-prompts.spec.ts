import { MODE_PROMPTS, requiredToolForMode } from './mode-prompts';

describe('MODE_PROMPTS', () => {
  it('has a non-empty prompt for every mode', () => {
    for (const mode of ['plan', 'implement', 'qa'] as const) {
      expect(MODE_PROMPTS[mode].length).toBeGreaterThan(0);
    }
  });

  it('names the completion tool and describe_server per mode', () => {
    expect(MODE_PROMPTS.implement).toContain('complete_assignment');
    expect(MODE_PROMPTS.plan).toContain('create_plan');
    expect(MODE_PROMPTS.qa).toContain('assure_assignment');
    for (const mode of ['plan', 'implement', 'qa'] as const) {
      expect(MODE_PROMPTS[mode]).toContain('describe_server');
    }
  });
});

describe('requiredToolForMode', () => {
  it('maps each mode to its required completion tool', () => {
    expect(requiredToolForMode('implement')).toBe('complete_assignment');
    expect(requiredToolForMode('plan')).toBe('create_plan');
    expect(requiredToolForMode('qa')).toBe('assure_assignment');
  });
});
