import { apiOptions, GlobalOptions } from '../core/cli-options';
import { apiRequest } from '../core/api';
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
}

interface ChatContextCmdOpts {
  roleId?: string;
  roleSlug?: string;
  companyId?: string;
  companySlug?: string;
}

/**
 * Resolves the session token and company/role identifiers for a chat
 * session. A role is identified either by `--role-id` alone, or by
 * `--role-slug` scoped to a company (`--company-id`/`--company-slug`) — the
 * company is then derived from the role (mirroring the agent's own
 * LLM-config resolution: role → company default → server env fallback).
 * With only a company given, no role/LLM config exists yet. Prints the
 * startup banner as a side effect.
 */
export async function resolveChatContext(
  opts: GlobalOptions,
  cmdOpts: ChatContextCmdOpts,
  useTui: boolean,
): Promise<ChatContext> {
  const { token, refreshToken } = await resolveSession({
    ...opts,
    baseUrl: opts.lcpServer,
  });

  let companyId: string;
  let roleId: string | undefined;
  let roleName = '';
  let llmConfig: LlmConfig | null | undefined;
  if (cmdOpts.roleId) {
    const role = await apiRequest<RoleRecord>(
      apiOptions(opts, token),
      'GET',
      `/api/role/${cmdOpts.roleId}`,
    );
    roleId = role.id;
    companyId = role.companyId;
    roleName = role.name;
    llmConfig = role.llmConfig;
  } else if (cmdOpts.roleSlug) {
    // Role slugs are unique only within a company, so resolving one always
    // requires a company identifier — enforced by validateChatFlags before
    // this runs. The company routes accept a UUID or a slug directly.
    const companyIdentifier = cmdOpts.companyId ?? cmdOpts.companySlug!;
    const role = await apiRequest<RoleRecord>(
      apiOptions(opts, token),
      'GET',
      `/api/company/${companyIdentifier}/roles/by-slug/${cmdOpts.roleSlug}`,
    );
    roleId = role.id;
    companyId = role.companyId;
    roleName = role.name;
    llmConfig = role.llmConfig;
  } else {
    companyId = cmdOpts.companyId ?? cmdOpts.companySlug!;
  }

  // The company GET route accepts a UUID or a slug directly, so the lookup
  // above works either way — this normalises companyId to the real UUID
  // regardless of which form was used to resolve it.
  const company = await apiRequest<CompanyRecord>(
    apiOptions(opts, token),
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
