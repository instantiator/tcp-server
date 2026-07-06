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
  llmDefault?: LlmConfig | null;
}

/** Resolved session + company/role identifiers a chat session needs to start. */
export interface ChatContext {
  token: string;
  refreshToken?: string;
  companyId: string;
  companySlug: string;
  companyName: string;
  roleName: string;
}

interface ChatContextCmdOpts {
  roleId?: string;
  companyId?: string;
}

/**
 * Resolves the session token and company/role identifiers for a chat
 * session — with `--role-id`, the company is derived from the role
 * (mirroring the agent's own LLM-config resolution: role → company default
 * → server env fallback); with `--company-id` alone, only the company is
 * resolved and no role/LLM config exists yet. Prints the startup banner as
 * a side effect.
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
  let roleName = '';
  let llmConfig: LlmConfig | null | undefined;
  if (cmdOpts.roleId) {
    const role = await apiRequest<RoleRecord>(
      apiOptions(opts, token),
      'GET',
      `/api/role/${cmdOpts.roleId}`,
    );
    companyId = role.companyId;
    roleName = role.name;
    llmConfig = role.llmConfig;
  } else {
    companyId = cmdOpts.companyId!;
  }

  const company = await apiRequest<CompanyRecord>(
    apiOptions(opts, token),
    'GET',
    `/api/company/${companyId}`,
  );
  const companyName = company.name;
  if (cmdOpts.roleId && !llmConfig) llmConfig = company.llmDefault;

  printBanner(opts, cmdOpts, roleName, companyName, llmConfig, useTui);

  return {
    token,
    refreshToken,
    companyId,
    companySlug: company.slug,
    companyName,
    roleName,
  };
}

/** Prints the server/LLM-or-company/role banner shown before the session starts. */
function printBanner(
  opts: GlobalOptions,
  cmdOpts: ChatContextCmdOpts,
  roleName: string,
  companyName: string,
  llmConfig: LlmConfig | null | undefined,
  useTui: boolean,
): void {
  process.stderr.write(`LCP API: ${opts.lcpServer}\n`);
  if (cmdOpts.roleId) {
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
