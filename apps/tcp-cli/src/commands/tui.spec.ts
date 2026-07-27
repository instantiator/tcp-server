import { Command } from 'commander';
import { registerTui } from './tui';

describe('registerTui', () => {
  it('registers with only company options — no role options, no --no-tui', () => {
    const program = new Command();
    registerTui(program);
    const tui = program.commands.find((c) => c.name() === 'tui')!;
    const flags = tui.options.map((o) => o.long);

    expect(flags).toEqual(
      expect.arrayContaining(['--company', '--company-id', '--company-slug']),
    );
    expect(flags).not.toEqual(
      expect.arrayContaining([
        '--role',
        '--role-id',
        '--role-slug',
        '--no-tui',
      ]),
    );
  });
});
