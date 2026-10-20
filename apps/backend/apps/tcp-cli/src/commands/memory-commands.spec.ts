import { Command } from 'commander';
import { registerAddMemory } from './add-memory';
import { registerDeleteMemory } from './delete-memory';
import { registerListMemories } from './list-memories';
import { registerUpdateMemory } from './update-memory';

describe('memory commands', () => {
  // Commander throws on a clashing flag when the command is registered, which
  // would stop the whole CLI starting; the action specs never register.
  it.each([
    ['add-memory', registerAddMemory],
    ['update-memory', registerUpdateMemory],
    ['delete-memory', registerDeleteMemory],
    ['list-memories', registerListMemories],
  ])('%s registers without a flag clash', (_, register) => {
    expect(() => register(new Command())).not.toThrow();
  });

  it('keeps -c for the company on add-memory', () => {
    const program = new Command();
    registerAddMemory(program);
    const add = program.commands.find((cmd) => cmd.name() === 'add-memory');
    expect(add?.options.find((o) => o.short === '-c')?.long).toBe('--company');
  });
});
