import { ContextBudgetService, LcpCompany, LcpRole } from '@lcp/shared';
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
    expect(breakdown.total).toBe(
      breakdown.systemPrompt +
        breakdown.rolePrompt +
        breakdown.companyContext +
        breakdown.servicesMessage +
        breakdown.query +
        breakdown.rag +
        breakdown.perTurn * breakdown.turns,
    );
  });

  it('counts actual tokens for role/company text when present', async () => {
    const role = { rolePrompt: 'You are a careful analyst.' } as LcpRole;
    const company = { companyContext: 'We build widgets.' } as LcpCompany;

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
    } as LcpRole;
    const company = {
      llmConfig: { provider: 'lm-studio', model: 'y', contextWindow: 16384 },
    } as LcpCompany;

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
