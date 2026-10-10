import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { utilitiesPrompts } from '../utilities-prompts';
import { UtilitiesToolsService } from './utilities-tools.service';

/** Calls a tool through a real MCP client, so input validation is exercised too. */
async function callTool(
  name: string,
  args: Record<string, unknown>,
): Promise<{ text: string; isError: boolean }> {
  const server = new UtilitiesToolsService().createServer();
  const client = new Client({ name: 'spec', version: '0.0.0' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  try {
    const result = CallToolResultSchema.parse(
      await client.callTool({ name, arguments: args }),
    );
    const first = result.content[0];
    return {
      text: first?.type === 'text' ? first.text : '',
      isError: result.isError === true,
    };
  } finally {
    await client.close();
  }
}

describe('UtilitiesToolsService', () => {
  it('describe_server returns the overview', async () => {
    expect((await callTool('describe_server', {})).text).toBe(
      utilitiesPrompts.describe_server,
    );
  });

  describe('calculate', () => {
    it('returns the exact decimal result', async () => {
      expect(
        (await callTool('calculate', { expression: '3 * 4.99 * 1.2' })).text,
      ).toBe('17.964');
    });

    it('returns a mistake as an error the model can correct', async () => {
      const { text } = await callTool('calculate', { expression: '1 / 0' });
      expect(text).toMatch(/^Error: /);
    });
  });

  describe('date_math', () => {
    it('returns the result as JSON', async () => {
      const { text } = await callTool('date_math', {
        operation: 'add',
        date: '2026-01-31',
        months: 1,
      });
      expect(JSON.parse(text)).toEqual({
        result: '2026-02-28',
        clamped: true,
      });
    });

    it('returns a bad date as an error', async () => {
      const { text } = await callTool('date_math', {
        operation: 'add',
        date: '31/01/2026',
        days: 1,
      });
      expect(text).toMatch(/^Error: .*YYYY-MM-DD/);
    });

    it('rejects an unknown operation before running', async () => {
      const { isError } = await callTool('date_math', {
        operation: 'multiply',
        date: '2026-01-31',
      });
      expect(isError).toBe(true);
    });
  });

  describe('convert_units', () => {
    it('states the conversion', async () => {
      expect(
        (await callTool('convert_units', { value: '1', from: 'lb', to: 'kg' }))
          .text,
      ).toBe('1 lb = 0.45359237 kg');
    });

    it('returns an incompatible pair as an error', async () => {
      const { text } = await callTool('convert_units', {
        value: '1',
        from: 'kg',
        to: 'cm',
      });
      expect(text).toMatch(/^Error: /);
    });
  });
});
