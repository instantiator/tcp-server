import type { LcpAgent } from '../models/LcpAgent.model';
import type { LcpArtifact } from '../models/LcpArtifact';
import type { LcpAssignment } from '../models/LcpAssignment.model';
import type { LcpCompany } from '../models/LcpCompany.model';
import type { LcpRole } from '../models/LcpRole.model';
import { MCP_REGISTRY } from '../mcp/mcp-registry';
import {
  ArtifactResolutionContext,
  resolveArtifactKey,
} from '../storage/artifact-keys';
import { DEFAULT_SYSTEM_PROMPT_TEMPLATE } from '../llm/default-system-prompt-template';
import { resolveSystemPromptTemplate } from '../config/resolve-system-prompt-template';
import { renderTemplate } from '../llm/render-template';
import { buildPromptDateVars } from '../llm/prompt-vars';
import { MODE_PROMPTS } from './mode-prompts';

/**
 * Pure, unit-testable builders for the individual initial-prompt parts (see
 * ADR-013), shared by both agent-operation paths: lcp-agent's
 * `AgentLoopService.buildInitialState` (worker runs) and lcp-server's
 * `ChatService` (in-process chat turns). Keeping each concern here makes the
 * prompt content testable without spinning up the whole agent loop, and keeps
 * the two paths from drifting.
 *
 * The two callers differ only in the fixed strings they render with, so those
 * are passed in as {@link PromptAssemblyStrings} rather than closed over.
 */

/**
 * The fixed strings the prompt-part builders render with. lcp-agent supplies
 * its jsonc-loaded `agentPrompts`; lcp-server supplies its own equivalent set.
 * All `{{...}}` placeholders are substituted by {@link renderTemplate}.
 */
export interface PromptAssemblyStrings {
  /** Heading for the available-services section (prompt part 3). */
  services_header: string;
  /** Body text introducing the service list (prompt part 3). */
  services_intro: string;
  /** Per-service bullet template; `{{name}}` and `{{usage}}` are substituted. */
  services_item: string;
  /** Bullet template for a server with no known {@link MCP_REGISTRY} usage; `{{name}}` is substituted. */
  services_item_unknown: string;
  /** Introductory sentence before RAG excerpts (prompt part 5). */
  rag_intro: string;
  /** Per-chunk heading template; `{{documentPath}}` is substituted (prompt part 5). */
  rag_source_header: string;
  /** Heading for the materials list in the assignment-presentation part (part 4). */
  assignment_materials_header: string;
  /** Heading for the expected-outputs list in the assignment-presentation part (part 4). */
  assignment_expected_header: string;
}

/**
 * Renders prompt part 0 — the system prompt — from the role's (or company's,
 * or default) system-prompt template with the agent's identity/date vars.
 */
export function renderSystemPrompt(
  agent: LcpAgent,
  role: LcpRole,
  company: LcpCompany | null,
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
    companySlug: company?.slug ?? '',
    roleSlug: role.slug,
  });
}

/**
 * Formats the services-available message for prompt part 3.
 * Each line gives the "when to use this" framing from {@link MCP_REGISTRY};
 * tool-level detail is deliberately omitted — every tool's full schema is bound
 * to the model from the first turn (so it already sees the parameters), and a
 * service's `describe_server` tool provides richer per-tool docs on demand.
 */
export function buildServicesMessage(
  serverNames: string[],
  serverUrls: Record<string, string>,
  strings: PromptAssemblyStrings,
): string {
  const lines = serverNames
    .filter((n) => serverUrls[n])
    .map((n) => {
      const usage = MCP_REGISTRY.find((s) => s.name === n)?.usage;
      return usage
        ? renderTemplate(strings.services_item, { name: n, usage })
        : renderTemplate(strings.services_item_unknown, { name: n });
    });

  if (lines.length === 0) return '';

  return [
    strings.services_header,
    '',
    strings.services_intro,
    '',
    lines.join('\n'),
  ].join('\n');
}

/** Formats RAG chunks as a prompt part 5 message. */
export function buildRagMessage(
  chunks: { documentPath: string; content: string }[],
  strings: PromptAssemblyStrings,
): string {
  const sections = chunks
    .map(
      (c) =>
        `${renderTemplate(strings.rag_source_header, { documentPath: c.documentPath })}\n\n${c.content}`,
    )
    .join('\n\n---\n\n');
  return `${strings.rag_intro}\n\n${sections}`;
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
 * Builds prompt part 4 — the assignment presentation. Composes the mode prompt,
 * the assignment prompt (if any), and, when present, the resolved Materials and
 * Expected-outputs lists. Path artifacts are shown as their resolved storage
 * key; `inline-text` shows its literal value.
 *
 * For a chat agent, `mode` is `chat`, `prompt` is the user's message, and
 * materials/expected are empty — so the message is the chat mode prompt
 * followed by the user's message.
 */
export function buildAssignmentMessage(
  params: AssignmentMessageParams,
  strings: PromptAssemblyStrings,
): string {
  const { mode, prompt, materials, expected, resolutionContext } = params;
  const blocks: string[] = [MODE_PROMPTS[mode]];

  if (prompt.trim()) {
    blocks.push(prompt);
  }

  if (materials.length > 0) {
    blocks.push(
      renderArtifactList(
        strings.assignment_materials_header,
        materials,
        resolutionContext,
      ),
    );
  }

  if (expected.length > 0) {
    blocks.push(
      renderArtifactList(
        strings.assignment_expected_header,
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
