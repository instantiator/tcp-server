import { readJsonBody } from './read-json-body';
import * as stdinModule from './stdin';

afterEach(() => jest.restoreAllMocks());

describe('readJsonBody', () => {
  it('parses --input when given, without touching stdin', async () => {
    const stdinSpy = jest.spyOn(stdinModule, 'readStdin');
    const body = await readJsonBody({ input: '{"name":"acme"}' });
    expect(body).toEqual({ name: 'acme' });
    expect(stdinSpy).not.toHaveBeenCalled();
  });

  it('falls back to stdin when --input is omitted', async () => {
    jest.spyOn(stdinModule, 'readStdin').mockResolvedValue('{"name":"acme"}');
    const body = await readJsonBody({});
    expect(body).toEqual({ name: 'acme' });
  });

  it('exits with an error when the input is not a JSON object', async () => {
    const exitSpy = jest
      .spyOn(process, 'exit')
      .mockImplementation(() => undefined as never);
    const stderrSpy = jest
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);

    await readJsonBody({ input: '"just a string"' });

    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('must be a JSON object'),
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
