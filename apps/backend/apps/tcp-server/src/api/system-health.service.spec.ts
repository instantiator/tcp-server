import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ServerHealthService } from '../health/server-health.service';
import { SystemHealthService } from './system-health.service';

/** The URL a `fetch` call was made with. */
const urlOf = (input: Parameters<typeof fetch>[0]): string =>
  typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.href
      : input.url;

describe('SystemHealthService', () => {
  const urls = {
    TCP_AGENT_URL: 'http://tcp-agent:3001',
    MCP_STORAGE_URL: 'http://tcp-mcp-storage:3010/mcp',
    MCP_MEMORY_URL: 'http://tcp-mcp-memory:3011',
    MCP_INTERACTIONS_URL: 'http://tcp-mcp-interactions:3012',
    MCP_TASKS_URL: 'http://tcp-mcp-tasks:3013',
  };
  let fetchMock: jest.SpyInstance<Promise<Response>, Parameters<typeof fetch>>;
  let selfCheck: jest.Mock<Promise<unknown>, []>;

  const build = (config: Record<string, string> = urls) =>
    new SystemHealthService(
      { check: selfCheck } as unknown as ServerHealthService,
      new ConfigService(config),
    );

  /** Answers every probe with 200 and a small body, except the overrides. */
  const answer = (overrides: Record<string, () => Promise<Response>> = {}) =>
    fetchMock.mockImplementation((input) => {
      const url = urlOf(input);
      const override = Object.entries(overrides).find(([host]) =>
        url.includes(host),
      );
      if (override) return override[1]();
      return Promise.resolve(Response.json({ status: 'ok' }));
    });

  beforeEach(() => {
    fetchMock = jest.spyOn(global, 'fetch');
    selfCheck = jest.fn(() => Promise.resolve({ status: 'ok' }));
  });

  afterEach(() => fetchMock.mockRestore());

  it('reports ok when every service is up, in a fixed order', async () => {
    answer();
    const report = await build().check();
    expect(report.status).toBe('ok');
    expect(report.services.map((s) => [s.name, s.status])).toEqual([
      ['tcp-server', 'up'],
      ['tcp-agent', 'up'],
      ['tcp-mcp-storage', 'up'],
      ['tcp-mcp-memory', 'up'],
      ['tcp-mcp-interactions', 'up'],
      ['tcp-mcp-tasks', 'up'],
    ]);
  });

  it('probes /health at the origin of each URL', async () => {
    answer();
    await build().check();
    const called = fetchMock.mock.calls.map(([input]) => urlOf(input));
    expect(called).toContain('http://tcp-mcp-storage:3010/health');
    expect(called).toContain('http://tcp-agent:3001/health');
  });

  it('counts a non-2xx answer as down, keeping its body', async () => {
    answer({
      'tcp-agent': () =>
        Promise.resolve(Response.json({ status: 'error' }, { status: 503 })),
    });
    const report = await build().check();
    expect(report.status).toBe('degraded');
    expect(report.services[1]).toEqual({
      name: 'tcp-agent',
      status: 'down',
      detail: { status: 'error' },
    });
  });

  it('counts a probe that throws (refused, timed out) as down, with why', async () => {
    answer({
      'tcp-mcp-tasks': () =>
        Promise.reject(new Error('The operation was aborted due to timeout')),
    });
    const report = await build().check();
    expect(report.status).toBe('degraded');
    expect(report.services[5]).toEqual({
      name: 'tcp-mcp-tasks',
      status: 'down',
      error: 'The operation was aborted due to timeout',
    });
  });

  it('reports a service with no URL as not configured, without degrading', async () => {
    answer();
    const rest = Object.fromEntries(
      Object.entries(urls).filter(([key]) => key !== 'MCP_MEMORY_URL'),
    );
    const report = await build(rest).check();
    expect(report.status).toBe('ok');
    expect(report.services[3]).toEqual({
      name: 'tcp-mcp-memory',
      status: 'not_configured',
    });
  });

  it("reports tcp-server down when its own checks fail, with Terminus's document", async () => {
    answer();
    selfCheck.mockRejectedValue(
      new ServiceUnavailableException({
        status: 'error',
        error: { redis: {} },
      }),
    );
    const report = await build().check();
    expect(report.status).toBe('degraded');
    expect(report.services[0]).toEqual({
      name: 'tcp-server',
      status: 'down',
      detail: { status: 'error', error: { redis: {} } },
    });
  });
});
