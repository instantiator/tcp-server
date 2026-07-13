import { MODE_PROMPTS, requiredToolForMode } from './mode-prompts';

describe('MODE_PROMPTS', () => {
  it('has a non-empty prompt for every mode', () => {
    for (const mode of ['plan', 'implement', 'qa', 'chat'] as const) {
      expect(MODE_PROMPTS[mode].length).toBeGreaterThan(0);
    }
  });

  it('names the completion tool and describe_server per work mode', () => {
    expect(MODE_PROMPTS.implement).toContain('complete_assignment');
    expect(MODE_PROMPTS.plan).toContain('create_plan');
    expect(MODE_PROMPTS.qa).toContain('assure_assignment');
    for (const mode of ['plan', 'implement', 'qa'] as const) {
      expect(MODE_PROMPTS[mode]).toContain('describe_server');
    }
  });

  it('spells out the chat behaviours: interact, consult, act, no completion tool', () => {
    const chat = MODE_PROMPTS.chat.toLowerCase();
    expect(chat).toContain('conversation');
    expect(chat).toContain('consult');
    expect(chat).toContain('take the action');
    expect(chat).toContain('no completion tool');
  });
});

describe('requiredToolForMode', () => {
  it('maps each work mode to its required completion tool', () => {
    expect(requiredToolForMode('implement')).toEqual(['complete_assignment']);
    expect(requiredToolForMode('plan')).toEqual(['create_plan']);
    expect(requiredToolForMode('qa')).toEqual(['assure_assignment']);
  });

  it('requires no tool for chat mode', () => {
    expect(requiredToolForMode('chat')).toEqual([]);
  });
});
