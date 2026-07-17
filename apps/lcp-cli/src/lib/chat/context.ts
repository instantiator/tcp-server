import { apiOptions, GlobalOptions } from '../core/cli-options';
import { apiRequest } from '../core/api';
import { EntityRefOpts, resolveRoleId } from '../core/entity-ref';
import { resolveSession } from '../auth/token';

interface LlmConfig {
  provider: string;
  model: string;
  baseUrl?: string;
}

interface RoleRecord {
  id: string;
  companyId: string;
  name: string;
  slug: string;
  llmConfig?: LlmConfig | null;
}

interface CompanyRecord {
  id: string;
  slug: string;
  name: string;
  llmConfig?: LlmConfig | null;
}

/** Resolved session + company/role identifiers a chat session needs to start. */
export interface ChatContext {
  token: string;
  refreshToken?: string;
  /** The resolved role UUID, present whenever a role (`--role-id` or `--role-slug`) was given. */
  roleId?: string;
  companyId: string;
  companySlug: string;
  companyName: string;
  roleName: string;
  /** The resolved role's slug — present exactly when `roleId` is. */
  roleSlug?: string;
}

/**
 * Resolves the session token and company/role identifiers for a chat
 * session. A role is identified by exactly one of `--role`, `--role-id`,
 * `--role-slug` — the company is then derived from the role (mirroring the
 * agent's own LLM-config resolution: role → company default → server env
 * fallback). With only a company given, no role/LLM config exists yet.
 * Prints the startup banner as a side effect.
 */
export async function resolveChatContext(
  opts: GlobalOptions,
  cmdOpts: EntityRefOpts,
  useTui: boolean,
): Promise<ChatContext> {
  const { token, refreshToken } = await resolveSession({
    ...opts,
    baseUrl: opts.lcpServer,
  });
  const api = apiOptions(opts, token);

  const roleGiven = Boolean(cmdOpts.role || cmdOpts.roleId || cmdOpts.roleSlug);

  let companyId: string;
  let roleId: string | undefined;
  let roleName = '';
  let roleSlug: string | undefined;
  let llmConfig: LlmConfig | null | undefined;
  if (roleGiven) {
    // resolveRoleId enforces (with the same error validateChatFlags
    // pre-checks) that a role slug is scoped to a resolvable company.
    roleId = await resolveRoleId(api, cmdOpts);
    const role = await apiRequest<RoleRecord>(
      api,
      'GET',
      `/api/role/${roleId}`,
    );
    companyId = role.companyId;
    roleName = role.name;
    roleSlug = role.slug;
    llmConfig = role.llmConfig;
  } else {
    // Company routes accept a UUID or a slug directly, so whichever was
    // given is passed straight through to the single detail-fetch call
    // below — no separate resolution round trip needed.
    companyId = cmdOpts.companyId ?? cmdOpts.companySlug ?? cmdOpts.company!;
  }

  const company = await apiRequest<CompanyRecord>(
    api,
    'GET',
    `/api/company/${companyId}`,
  );
  companyId = company.id;
  const companyName = company.name;
  if (roleId && !llmConfig) llmConfig = company.llmConfig;

  printBanner(opts, roleName, companyName, llmConfig, useTui);

  return {
    token,
    refreshToken,
    roleId,
    companyId,
    companySlug: company.slug,
    companyName,
    roleName,
    roleSlug,
  };
}

/** Prints the server/LLM-or-company/role banner shown before the session starts. */
function printBanner(
  opts: GlobalOptions,
  roleName: string,
  companyName: string,
  llmConfig: LlmConfig | null | undefined,
  useTui: boolean,
): void {
  process.stderr.write(`LCP API: ${opts.lcpServer}\n`);
  if (roleName) {
    if (llmConfig) {
      process.stderr.write(
        `LLM API: ${llmConfig.baseUrl ?? '(provider default)'}\n`,
      );
      process.stderr.write(`Provider: ${llmConfig.provider}\n`);
      process.stderr.write(`Model: ${llmConfig.model}\n`);
    } else {
      process.stderr.write(`LLM: (using server environment default)\n`);
    }
    process.stderr.write(`Role: ${roleName}\n`);
  } else {
    process.stderr.write(`Company: ${companyName}\n`);
  }
  if (!useTui) {
    process.stderr.write(`'exit', 'quit', or Ctrl+C to exit.\n`);
  }
}
