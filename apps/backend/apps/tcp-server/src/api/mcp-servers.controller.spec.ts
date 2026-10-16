import { ConfigService } from '@nestjs/config';
import { MCP_REGISTRY } from '@tcp/shared';
import { McpServersController } from './mcp-servers.controller';

describe('McpServersController', () => {
  it('lists the whole registry in order, flagging only configured servers', () => {
    const config = {
      get: (key: string) =>
        key === 'MCP_TASKS_URL' ? 'http://tasks:3000' : undefined,
    } as unknown as ConfigService;

    const list = new McpServersController(config).list();

    expect(list.map((s) => s.name)).toEqual(MCP_REGISTRY.map((s) => s.name));
    expect(list.filter((s) => s.available).map((s) => s.name)).toEqual([
      'tasks',
    ]);
    expect(list.map((s) => s.usage)).toEqual(MCP_REGISTRY.map((s) => s.usage));
  });
});
