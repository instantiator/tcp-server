import { ContextBudgetService, TcpCompany, TcpRole } from '@tcp/shared';
import { computeBreakdown } from './estimate-context-window.action';

describe('computeBreakdown', () => {
  const budget = new ContextBudgetService();

  it('uses default query/rag/turn estimates when none are given', async () => {
    const breakdown = await computeBreakdown(budget, {}, {});

    expect(breakdown.query).toBe(200);
    expect(breakdown.rag).toBe(2500);
    expect(breakdown.perTurn).toBe(300);
    expect(breakdown.turns).toBe(20);
    expect(breakdown.windowSize).toBe(8192);
    expect(breakdown.tools).toBe(0);
    expect(breakdown.total).toBe(
      breakdown.systemPrompt +
        breakdown.rolePrompt +
        breakdown.companyContext +
        breakdown.servicesMessage +
        breakdown.tools +
        breakdown.query +
        breakdown.rag +
        breakdown.perTurn * breakdown.turns,
    );
  });

  it("falls back to the env file's LLM_CONTEXT_WINDOW before the built-in default", async () => {
    process.env['LLM_CONTEXT_WINDOW'] = '32768';
    try {
      expect((await computeBreakdown(budget, {}, {})).windowSize).toBe(32768);
    } finally {
      delete process.env['LLM_CONTEXT_WINDOW'];
    }
  });

  it('adds the tool schema tokens to the total', async () => {
    const without = await computeBreakdown(budget, {}, {});
    const withTools = await computeBreakdown(budget, {}, { toolTokens: 1500 });
    expect(withTools.tools).toBe(1500);
    expect(withTools.total - without.total).toBe(1500);
  });

  it('describes only the MCP servers the company and role leave switched on', async () => {
    const all = await computeBreakdown(budget, {}, {});
    const lean = await computeBreakdown(
      budget,
      {
        company: { mcpServerToggles: { records: false } },
        role: { mcpServerToggles: { utilities: false } },
      },
      {},
    );
    expect(lean.servicesMessage).toBeLessThan(all.servicesMessage);
  });

  it('counts actual tokens for role/company text when present', async () => {
    const role = { rolePrompt: 'You are a careful analyst.' } as TcpRole;
    const company = { companyContext: 'We build widgets.' } as TcpCompany;

    const breakdown = await computeBreakdown(budget, { role, company }, {});

    expect(breakdown.rolePrompt).toBeGreaterThan(0);
    expect(breakdown.companyContext).toBeGreaterThan(0);
  });

  it('counts an explicit --query string exactly instead of using the default estimate', async () => {
    const breakdown = await computeBreakdown(
      budget,
      {},
      { query: 'What were Q3 sales?' },
    );

    expect(breakdown.query).not.toBe(200);
    expect(breakdown.query).toBeGreaterThan(0);
  });

  it('respects explicit overrides for query/rag/turn tokens and turn count', async () => {
    const breakdown = await computeBreakdown(
      budget,
      {},
      { queryTokens: 50, ragTokens: 100, turnTokens: 10, turns: 2 },
    );

    expect(breakdown.query).toBe(50);
    expect(breakdown.rag).toBe(100);
    expect(breakdown.perTurn).toBe(10);
    expect(breakdown.turns).toBe(2);
  });

  it("resolves the window size from the role's llmConfig over the company's", async () => {
    const role = {
      llmConfig: { provider: 'lm-studio', model: 'x', contextWindow: 4096 },
    } as TcpRole;
    const company = {
      llmConfig: { provider: 'lm-studio', model: 'y', contextWindow: 16384 },
    } as TcpCompany;

    const breakdown = await computeBreakdown(budget, { role, company }, {});
    expect(breakdown.windowSize).toBe(4096);
  });

  it('computes pctOfWindow relative to the resolved window size', async () => {
    const breakdown = await computeBreakdown(
      budget,
      {},
      { queryTokens: 0, ragTokens: 0, turnTokens: 0, turns: 0 },
    );
    expect(breakdown.pctOfWindow).toBe(
      budget.pct(breakdown.total, breakdown.windowSize),
    );
  });
});
