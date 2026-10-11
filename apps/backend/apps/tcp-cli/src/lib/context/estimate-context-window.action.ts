import { readFile } from 'fs/promises';
import {
  ContextBudgetService,
  DEFAULT_LLM_CONTEXT_WINDOW,
  DEFAULT_SYSTEM_PROMPT_TEMPLATE,
  TcpCompany,
  TcpRole,
  MCP_REGISTRY,
  buildPromptDateVars,
  renderTemplate,
  resolveLlmConfig,
  resolveMcpServerList,
  resolveSystemPromptTemplate,
} from '@tcp/shared';
import { resolveToken } from '../auth/token';
import { apiOptions, GlobalOptions } from '../core/cli-options';
import { apiRequest } from '../core/api';
import { runCommand } from '../core/run-command';
import { EntityRefOpts, UUID_RE } from '../core/entity-ref';

// Mirrors the server's RAG worst-case sizing: `knowledge-retrieval.service.ts`'s
// default `topK` (5 chunks) and `rag-index.service.ts`'s `MAX_CHUNK_CHARS`
// (2000) — not imported directly since tcp-cli doesn't depend on tcp-server.
const DEFAULT_RAG_TOP_K = 5;
const DEFAULT_RAG_CHUNK_CHARS = 2000;
const CHARS_PER_TOKEN = 4;

const DEFAULT_QUERY_TOKENS = 200;
const DEFAULT_TURN_TOKENS = 300;
const DEFAULT_TURNS = 20;

export interface EstimateContextWindowOpts extends EntityRefOpts {
  fromFile?: string;
  query?: string;
  queryTokens?: number;
  ragTokens?: number;
  turnTokens?: number;
  turns?: number;
  /** Mode whose tool set to count (default `implement`). */
  mode?: string;
  /** Tool schema tokens to assume, instead of asking tcp-server to count them. */
  toolTokens?: number;
  json?: boolean;
}

/** tcp-server's count of a role's MCP tool schemas, per server (`GET …/tool-footprint`). */
interface ToolFootprint {
  mode: string;
  servers: { name: string; tools: number; tokens: number; error?: string }[];
  total: number;
}

export interface PromptSizeBreakdown {
  systemPrompt: number;
  rolePrompt: number;
  companyContext: number;
  servicesMessage: number;
  /** MCP tool schemas, sent on every turn (0 when they weren't counted). */
  tools: number;
  query: number;
  rag: number;
  perTurn: number;
  turns: number;
  windowSize: number;
  total: number;
  pctOfWindow: number;
}

interface FileFixture {
  company?: Partial<TcpCompany>;
  role?: Partial<TcpRole>;
}

/** Loads `{ company, role }` from a JSON file instead of hitting a live server (see `--from-file`). */
async function loadFromFile(path: string): Promise<FileFixture> {
  const raw = await readFile(path, 'utf-8');
  return JSON.parse(raw) as FileFixture;
}

/** Loads `company`/`role` from the API when identifiers are given; either may be omitted. */
async function loadFromApi(
  api: Parameters<typeof apiRequest>[0],
  opts: EntityRefOpts,
): Promise<FileFixture> {
  const companyIdentifier = opts.companyId ?? opts.companySlug ?? opts.company;
  const roleGiven = Boolean(opts.roleId || opts.roleSlug || opts.role);
  if (!companyIdentifier && !roleGiven) return {};

  const company = companyIdentifier
    ? await apiRequest<TcpCompany>(
        api,
        'GET',
        `/api/company/${companyIdentifier}`,
      )
    : undefined;

  // A combined --role is an id when it looks like one, otherwise a slug
  // (scoped to the company resolved above, same as everywhere else).
  const roleId =
    opts.roleId ??
    (opts.role && UUID_RE.test(opts.role) ? opts.role : undefined);
  const roleSlug =
    opts.roleSlug ??
    (opts.role && !UUID_RE.test(opts.role) ? opts.role : undefined);

  let role: TcpRole | undefined;
  if (roleId) {
    role = await apiRequest<TcpRole>(api, 'GET', `/api/role/${roleId}`);
  } else if (roleSlug && company) {
    role = await apiRequest<TcpRole>(
      api,
      'GET',
      `/api/company/${company.id}/roles/by-slug/${roleSlug}`,
    );
  }

  return { company, role };
}

/** Prints each server's tool schema cost, so it's clear which servers to switch off. */
function reportFootprint(footprint: ToolFootprint): void {
  process.stderr.write(`Tool schemas (${footprint.mode} mode, worst case):\n`);
  for (const s of footprint.servers) {
    process.stderr.write(
      s.error
        ? `  ${s.name}: not counted (${s.error})\n`
        : `  ${s.name}: ${s.tools} tools, ~${s.tokens} tokens\n`,
    );
  }
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

  // Only the servers this company and role have switched on are described.
  const enabled = new Set(
    resolveMcpServerList(
      MCP_REGISTRY.map((s) => s.name),
      company,
      role,
    ),
  );
  const servicesMessage = MCP_REGISTRY.filter((s) => enabled.has(s.name))
    .map((s) => `${s.name}: ${s.usage}`)
    .join('\n');

  const llmConfig = resolveLlmConfig(role, company, null);
  // tcp-cli.sh exports the env file, so the servers' LLM_CONTEXT_WINDOW
  // fallback is visible here too.
  const windowSize =
    llmConfig?.contextWindow ??
    (Number(process.env['LLM_CONTEXT_WINDOW']) || DEFAULT_LLM_CONTEXT_WINDOW);

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
    tools: opts.toolTokens ?? 0,
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
    breakdown.tools +
    breakdown.query +
    breakdown.rag +
    breakdown.perTurn * breakdown.turns;
  breakdown.pctOfWindow = budget.pct(breakdown.total, breakdown.windowSize);

  return breakdown;
}

/**
 * Estimates the worst-case token footprint of an agent's initial prompt
 * (system prompt + role prompt + company context + services message + MCP
 * tool schemas + task query + RAG retrieval) plus `turns` further
 * conversation turns, and reports it against the resolved LLM's context
 * window. Tool schemas are counted by tcp-server, which can reach the MCP
 * servers; offline (`--from-file`) they come from `--tool-tokens`.
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

    let toolTokens = cmdOpts.toolTokens;
    if (cmdOpts.fromFile) {
      fixture = await loadFromFile(cmdOpts.fromFile);
    } else {
      const token = await resolveToken({ ...opts, baseUrl: opts.tcpServer });
      const api = apiOptions(opts, token);
      fixture = await loadFromApi(api, cmdOpts);
      if (toolTokens === undefined && fixture.company?.id && fixture.role?.id) {
        const footprint = await apiRequest<ToolFootprint>(
          api,
          'GET',
          `/api/company/${fixture.company.id}/roles/by-slug/${fixture.role.id}/tool-footprint?mode=${encodeURIComponent(cmdOpts.mode ?? 'implement')}`,
        );
        reportFootprint(footprint);
        toolTokens = footprint.total;
      }
    }
    if (toolTokens === undefined) {
      process.stderr.write(
        'Tool schemas not counted: give a company and role on a live server, or --tool-tokens.\n',
      );
    }

    const breakdown = await computeBreakdown(budget, fixture, {
      ...cmdOpts,
      toolTokens,
    });

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
