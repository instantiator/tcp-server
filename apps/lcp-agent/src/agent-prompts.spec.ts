import { agentPrompts } from './agent-prompts';

describe('agentPrompts loader', () => {
  it('loads all required keys as non-empty strings', () => {
    expect(typeof agentPrompts.final_instruction).toBe('string');
    expect(agentPrompts.final_instruction.length).toBeGreaterThan(0);
  });
});
