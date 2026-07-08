import { readFile } from 'fs/promises';
import {
  ContextBudgetService,
  DEFAULT_LLM_CONTEXT_WINDOW,
  DEFAULT_SYSTEM_PROMPT_TEMPLATE,
  LcpCompany,
  LcpRole,
  MCP_REGISTRY,
  buildPromptDateVars,
  renderTemplate,
  resolveLlmConfig,
  resolveSystemPromptTemplate,
} from '@lcp/shared';
import { resolveToken } from '../auth/token';
import { apiOptions, GlobalOptions } from '../core/cli-options';
import { apiRequest } from '../core/api';
import { runCommand } from '../core/run-command';
import { RoleIdentifierOpts } from '../core/resolve-identifiers';

// Mirrors the server's RAG worst-case sizing: `rag-retrieval.service.ts`'s
// default `topK` (5 chunks) and `rag-index.service.ts`'s `MAX_CHUNK_CHARS`
// (2000) — not imported directly since lcp-cli doesn't depend on lcp-server.
const DEFAULT_RAG_TOP_K = 5;
const DEFAULT_RAG_CHUNK_CHARS = 2000;
const CHARS_PER_TOKEN = 4;

const DEFAULT_QUERY_TOKENS = 200;
const DEFAULT_TURN_TOKENS = 300;
const DEFAULT_TURNS = 20;

export interface EstimateContextWindowOpts extends RoleIdentifierOpts {
  fromFile?: string;
  query?: string;
  queryTokens?: number;
  ragTokens?: number;
  turnTokens?: number;
  turns?: number;
  json?: boolean;
}

export interface PromptSizeBreakdown {
  systemPrompt: number;
  rolePrompt: number;
  companyContext: number;
  servicesMessage: number;
  query: number;
  rag: number;
  perTurn: number;
  turns: number;
  windowSize: number;
  total: number;
  pctOfWindow: number;
}

interface FileFixture {
  company?: Partial<LcpCompany>;
  role?: Partial<LcpRole>;
}

/** Loads `{ company, role }` from a JSON file instead of hitting a live server (see `--from-file`). */
async function loadFromFile(path: string): Promise<FileFixture> {
  const raw = await readFile(path, 'utf-8');
  return JSON.parse(raw) as FileFixture;
}

/** Loads `company`/`role` from the API when identifiers are given; either may be omitted. */
async function loadFromApi(
  api: Parameters<typeof apiRequest>[0],
  opts: RoleIdentifierOpts,
): Promise<FileFixture> {
  const companyIdentifier = opts.companyId ?? opts.companySlug;
  if (!companyIdentifier && !opts.roleId && !opts.roleSlug) return {};

  const company = companyIdentifier
    ? await apiRequest<LcpCompany>(
        api,
        'GET',
        `/api/company/${companyIdentifier}`,
      )
    : undefined;

  let role: LcpRole | undefined;
  if (opts.roleId) {
    role = await apiRequest<LcpRole>(api, 'GET', `/api/role/${opts.roleId}`);
  } else if (opts.roleSlug && company) {
    role = await apiRequest<LcpRole>(
      api,
      'GET',
      `/api/company/${company.id}/roles/by-slug/${opts.roleSlug}`,
    );
  }

  return { company, role };
}

/** Computes an estimated worst-case token breakdown for an agent's initial prompt plus a run of turns. */
export async function computeBreakdown(
  budget: ContextBudgetService,
  { company, role }: FileFixture,
  opts: EstimateContextWindowOpts,
): Promise<PromptSizeBreakdown> {
  const systemPromptTemplate = resolveSystemPromptTemplate(
    role,
    company,
    DEFAULT_SYSTEM_PROMPT_TEMPLATE,
  );
  const systemPrompt = renderTemplate(systemPromptTemplate, {
    name: role?.name ?? '<role>',
    description: role?.description ?? '',
    ...buildPromptDateVars(company),
    companyId: company?.id ?? '',
    roleId: role?.id ?? '',
    companySlug: company?.slug ?? '',
    roleSlug: role?.slug ?? '',
  });

  const servicesMessage = MCP_REGISTRY.map((s) => `${s.name}: ${s.usage}`).join(
    '\n',
  );

  const llmConfig = resolveLlmConfig(role, company, null);
  const windowSize = llmConfig?.contextWindow ?? DEFAULT_LLM_CONTEXT_WINDOW;

  const queryTokens = opts.query
    ? await budget.countText(opts.query)
    : (opts.queryTokens ?? DEFAULT_QUERY_TOKENS);
  const ragTokens =
    opts.ragTokens ??
    Math.ceil((DEFAULT_RAG_TOP_K * DEFAULT_RAG_CHUNK_CHARS) / CHARS_PER_TOKEN);
  const turnTokens = opts.turnTokens ?? DEFAULT_TURN_TOKENS;
  const turns = opts.turns ?? DEFAULT_TURNS;

  const breakdown: PromptSizeBreakdown = {
    systemPrompt: await budget.countText(systemPrompt),
    rolePrompt: role?.rolePrompt ? await budget.countText(role.rolePrompt) : 0,
    companyContext: company?.companyContext
      ? await budget.countText(company.companyContext)
      : 0,
    servicesMessage: await budget.countText(servicesMessage),
    query: queryTokens,
    rag: ragTokens,
    perTurn: turnTokens,
    turns,
    windowSize,
    total: 0,
    pctOfWindow: 0,
  };

  breakdown.total =
    breakdown.systemPrompt +
    breakdown.rolePrompt +
    breakdown.companyContext +
    breakdown.servicesMessage +
    breakdown.query +
    breakdown.rag +
    breakdown.perTurn * breakdown.turns;
  breakdown.pctOfWindow = budget.pct(breakdown.total, breakdown.windowSize);

  return breakdown;
}

/**
 * Estimates the worst-case token footprint of an agent's initial prompt
 * (system prompt + role prompt + company context + services message + task
 * query + RAG retrieval) plus `turns` further conversation turns, and reports
 * it against the resolved LLM's context window.
 *
 * stdout: the total token count (default) or the full JSON breakdown (`--json`).
 * stderr: progress and the values actually used for the estimate.
 */
export function estimateContextWindowAction(
  opts: GlobalOptions,
  cmdOpts: EstimateContextWindowOpts,
): Promise<void> {
  return runCommand(async () => {
    const budget = new ContextBudgetService();
    let fixture: FileFixture;

    if (cmdOpts.fromFile) {
      fixture = await loadFromFile(cmdOpts.fromFile);
    } else {
      const token = await resolveToken({ ...opts, baseUrl: opts.lcpServer });
      const api = apiOptions(opts, token);
      fixture = await loadFromApi(api, cmdOpts);
    }

    const breakdown = await computeBreakdown(budget, fixture, cmdOpts);

    process.stderr.write(
      `Using window size ${breakdown.windowSize} tokens, ${breakdown.turns} turns at ~${breakdown.perTurn} tokens/turn, RAG estimate ~${breakdown.rag} tokens.\n`,
    );

    if (cmdOpts.json) {
      process.stdout.write(JSON.stringify(breakdown, null, 2) + '\n');
    } else {
      process.stdout.write(`${breakdown.total}\n`);
    }
  });
}
