import {
  ArtifactResolutionContext,
  DEFAULT_SYSTEM_PROMPT_TEMPLATE,
  LcpAgent,
  LcpArtifact,
  LcpAssignment,
  LcpCompany,
  LcpRole,
  MODE_PROMPTS,
  buildPromptDateVars,
  renderTemplate,
  resolveArtifactKey,
  resolveSystemPromptTemplate,
} from '@lcp/shared';
import { agentPrompts } from '../agent-prompts';
import { MCP_REGISTRY } from '../mcp/mcp-registry';

/**
 * Pure, unit-testable builders for the individual initial-prompt parts (see
 * ADR-013). `AgentLoopService.buildInitialState` composes these into the
 * message list; keeping each concern here makes the prompt content testable
 * without spinning up the whole agent loop.
 */

/**
 * Renders prompt part 0 — the system prompt — from the role's (or company's,
 * or default) system-prompt template with the agent's identity/date vars.
 */
export function renderSystemPrompt(
  agent: LcpAgent,
  role: LcpRole,
  company: LcpCompany,
): string {
  const systemPromptTemplate = resolveSystemPromptTemplate(
    role,
    company,
    DEFAULT_SYSTEM_PROMPT_TEMPLATE,
  );
  return renderTemplate(systemPromptTemplate, {
    name: role.name,
    description: role.description,
    ...buildPromptDateVars(company),
    companyId: agent.companyId,
    roleId: role.id,
    // Slugs alongside the ids so the agent can consult by slug (see
    // request_agent_consultation's companySlug/roleSlug), which reads
    // more naturally in a rendered prompt than a bare UUID.
    companySlug: company.slug,
    roleSlug: role.slug,
  });
}

/**
 * Formats the services-available message for prompt part 3.
 * Each line gives the "when to use this" framing from {@link MCP_REGISTRY};
 * tool-level detail is deliberately omitted — a service's other tools only
 * become bound once the agent calls its `describe_server` tool (see
 * {@link ToolVisibilityTracker}), so restating them here would duplicate
 * what the model sees once it actually describes the service.
 */
export function buildServicesMessage(
  serverNames: string[],
  serverUrls: Record<string, string>,
): string {
  const lines = serverNames
    .filter((n) => serverUrls[n])
    .map((n) => {
      const usage = MCP_REGISTRY.find((s) => s.name === n)?.usage;
      return usage
        ? renderTemplate(agentPrompts.services_item, { name: n, usage })
        : renderTemplate(agentPrompts.services_item_unknown, { name: n });
    });

  if (lines.length === 0) return '';

  return [
    agentPrompts.services_header,
    '',
    agentPrompts.services_intro,
    '',
    lines.join('\n'),
  ].join('\n');
}

/** Formats RAG chunks as a prompt part 5 message. */
export function buildRagMessage(
  chunks: { documentPath: string; content: string }[],
): string {
  const sections = chunks
    .map(
      (c) =>
        `${renderTemplate(agentPrompts.rag_source_header, { documentPath: c.documentPath })}\n\n${c.content}`,
    )
    .join('\n\n---\n\n');
  return `${agentPrompts.rag_intro}\n\n${sections}`;
}

/** Inputs for {@link buildAssignmentMessage} — prompt part 4. */
export interface AssignmentMessageParams {
  /** The assignment's mode — selects the {@link MODE_PROMPTS} preamble. */
  mode: LcpAssignment['mode'];
  /**
   * The assignment/task prompt. Already passed through
   * {@link ContextManagerService.prepare} by the caller. Empty (chat-start)
   * omits the prompt block, keeping just the mode prompt.
   */
  prompt: string;
  /** Highlighted materials for the assignment (empty for orphans). */
  materials: LcpArtifact[];
  /** Expected outputs the completed work must satisfy (empty for orphans). */
  expected: LcpArtifact[];
  /** Context for resolving material/expected artifact keys. */
  resolutionContext: ArtifactResolutionContext;
}

/**
 * Builds prompt part 4 — the assignment presentation — replacing the old bare
 * initial-prompt message. Composes the mode prompt, the assignment prompt (if
 * any), and, when present, the resolved Materials and Expected-outputs lists.
 * Path artifacts are shown as their resolved storage key; `inline-text` shows
 * its literal value.
 */
export function buildAssignmentMessage(
  params: AssignmentMessageParams,
): string {
  const { mode, prompt, materials, expected, resolutionContext } = params;
  const blocks: string[] = [MODE_PROMPTS[mode]];

  if (prompt.trim()) {
    blocks.push(prompt);
  }

  if (materials.length > 0) {
    blocks.push(
      renderArtifactList(
        agentPrompts.assignment_materials_header,
        materials,
        resolutionContext,
      ),
    );
  }

  if (expected.length > 0) {
    blocks.push(
      renderArtifactList(
        agentPrompts.assignment_expected_header,
        expected,
        resolutionContext,
      ),
    );
  }

  return blocks.join('\n\n');
}

/** Renders a heading followed by one bullet per artifact (resolved key, or inline value). */
function renderArtifactList(
  header: string,
  artifacts: LcpArtifact[],
  ctx: ArtifactResolutionContext,
): string {
  const items = artifacts.map(
    (a) => `- ${resolveArtifactKey(a, ctx) ?? a.value}`,
  );
  return [header, ...items].join('\n');
}
