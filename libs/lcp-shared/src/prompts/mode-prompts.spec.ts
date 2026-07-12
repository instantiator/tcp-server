import { MODE_PROMPTS, requiredToolForMode } from './mode-prompts';

describe('MODE_PROMPTS', () => {
  it('has a non-empty prompt for every mode', () => {
    for (const mode of ['plan', 'implement', 'qa'] as const) {
      expect(MODE_PROMPTS[mode].length).toBeGreaterThan(0);
    }
  });

  it('names the completion tool and describe_server per mode', () => {
    // TODO(010.2.5): implement switches complete_task → complete_assignment.
    expect(MODE_PROMPTS.implement).toContain('complete_task');
    expect(MODE_PROMPTS.plan).toContain('create_plan');
    expect(MODE_PROMPTS.qa).toContain('assure_assignment');
    for (const mode of ['plan', 'implement', 'qa'] as const) {
      expect(MODE_PROMPTS[mode]).toContain('describe_server');
    }
  });
});

describe('requiredToolForMode', () => {
  it('maps each mode to its required completion tool', () => {
    // TODO(010.2.5): implement becomes complete_assignment.
    expect(requiredToolForMode('implement')).toBe('complete_task');
    expect(requiredToolForMode('plan')).toBe('create_plan');
    expect(requiredToolForMode('qa')).toBe('assure_assignment');
  });
});
