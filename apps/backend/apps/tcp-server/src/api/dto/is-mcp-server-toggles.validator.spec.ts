import { validate } from 'class-validator';
import { IsMcpServerToggles } from './is-mcp-server-toggles.validator';

class Probe {
  @IsMcpServerToggles()
  toggles: unknown;
}

async function errorsFor(toggles: unknown): Promise<string[]> {
  const probe = new Probe();
  probe.toggles = toggles;
  const errors = await validate(probe);
  return errors.flatMap((e) => Object.values(e.constraints ?? {}));
}

describe('IsMcpServerToggles', () => {
  it.each([
    ['null (no preference)', null],
    ['an empty map', {}],
    ['known servers switched on and off', { records: false, utilities: true }],
  ])('accepts %s', async (_label, value) => {
    expect(await errorsFor(value)).toEqual([]);
  });

  it.each([
    ['a misspelt server', { recrods: false }],
    ['a non-boolean value', { records: 'off' }],
    ['a list', ['records']],
    ['a string', 'records'],
  ])('refuses %s, naming the servers that work', async (_label, value) => {
    const [message] = await errorsFor(value);
    expect(message).toMatch(/records/);
    expect(message).toMatch(/tasks/);
  });
});
