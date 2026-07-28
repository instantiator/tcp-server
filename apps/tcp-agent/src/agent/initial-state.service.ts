import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { MessagesAnnotation } from '@langchain/langgraph';
import {
  buildAssignmentMessage,
  buildAvailableRolesMessage,
  buildRagMessage,
  buildServicesMessage,
  DEFAULT_RAG_THRESHOLD,
  KnowledgeRetrievalService,
  McpClientService,
  renderSystemPrompt,
  resolveEmbeddingConfig,
  resolveEnvEmbeddingConfig,
  resolveRunConfig,
  TcpAgent,
  TcpAssignment,
  TcpRole,
} from '@tcp/shared';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { agentPrompts } from '../agent-prompts';

/**
 * Assembles the numbered prompt parts that make up an agent's opening message
 * list — system prompt, role, company, services, assignment, roles roster, RAG
 * and the final instruction — in the order {@link buildInitialState} documents.
 *
 * Only the first run of an agent needs this; a resume injects the reply into
 * the existing LangGraph checkpoint instead.
 */
@Injectable()
export class InitialStateService {
  constructor(
    private readonly knowledge: KnowledgeRetrievalService,
    private readonly config: ConfigService,
    @InjectRepository(TcpRole)
    private readonly roleRepo: Repository<TcpRole>,
    @InjectRepository(TcpAssignment)
    private readonly assignmentRepo: Repository<TcpAssignment>,
  ) {}

  /**
   * Builds the full initial-state message list for the first run of an agent.
   *
   * @param initialPrompt - The task prompt to use for prompt part 4, already
   *   passed through {@link ContextManagerService.prepare} (may differ from
   *   `agent.initialPrompt` if the incoming-data guard compacted it).
   */
  async build(
    agent: TcpAgent,
    mcpTools: Awaited<ReturnType<McpClientService['loadTools']>>,
    mcpServerUrls: Record<string, string>,
    initialPrompt: string,
    hasKnowledge: boolean,
  ): Promise<typeof MessagesAnnotation.State> {
    const { role, company, assignment } = agent;

    const ragMessage = await this.buildRagMessage(
      agent,
      initialPrompt,
      hasKnowledge,
    );

    const loadedServerNames = [...new Set(mcpTools.map((t) => t.serverName))];
    const servicesText = buildServicesMessage(
      loadedServerNames,
      mcpServerUrls,
      agentPrompts,
    );

    const assignmentMessage = new HumanMessage(
      await this.buildAssignmentText(agent, initialPrompt),
    );
    const rolesMessage = await this.buildRolesMessage(assignment, company.id);

    return {
      messages: [
        // Prompt part 0: system prompt — rendered from the role's systemPromptTemplate
        new SystemMessage(renderSystemPrompt(agent, role, company)),
        // Prompt part 1: role prompt (identity, attitude, domain knowledge, behavioural guidelines)
        ...(role.rolePrompt ? [new HumanMessage(role.rolePrompt)] : []),
        // Prompt part 2: company environment (name, description, shared storage layout, etc.)
        ...(company.companyContext
          ? [new HumanMessage(company.companyContext)]
          : []),
        // Prompt part 3: services available (MCP servers). Call describe_server on any for details.
        ...(servicesText ? [new HumanMessage(servicesText)] : []),
        // Prompt part 4: assignment presentation (mode prompt + assignment prompt + materials/expected)
        assignmentMessage,
        // Prompt part 4b: available roles (plan mode only) — the roster a planner assigns steps to
        ...(rolesMessage ? [rolesMessage] : []),
        // Prompt part 5: RAG data retrieved for the initial task (omitted when nothing relevant)
        ...(ragMessage ? [ragMessage] : []),
        // Prompt part 6: episodic memory — recalled prior run summaries relevant to this task (not yet implemented)
        // Prompt part 7: peer context — summaries of currently running sibling agents (not yet implemented)
        // Prompt part 8: final instruction — directs the agent to begin after all context is set
        new HumanMessage(agentPrompts.final_instruction),
      ],
    };
  }

  /**
   * Prompt part 5: knowledge retrieved for the opening prompt. Skips RAG
   * entirely (including the embedding call) when the role has no indexed
   * knowledge — there is nothing to retrieve.
   */
  private async buildRagMessage(
    agent: TcpAgent,
    initialPrompt: string,
    hasKnowledge: boolean,
  ): Promise<HumanMessage | null> {
    if (!hasKnowledge) return null;
    const { role, company } = agent;
    const chunks = await this.knowledge.retrieve(
      role.id,
      company.id,
      initialPrompt,
      resolveEmbeddingConfig(company, resolveEnvEmbeddingConfig(this.config)),
      undefined,
      resolveRunConfig(
        'ragThreshold',
        role,
        company,
        this.config.get<number>('RAG_THRESHOLD'),
        DEFAULT_RAG_THRESHOLD,
      ),
    );
    return chunks.length
      ? new HumanMessage(buildRagMessage(chunks, agentPrompts))
      : null;
  }

  /**
   * Prompt part 4: the mode prompt plus the assignment prompt (already
   * context-prepared) and any materials/expected outputs, with the context
   * needed to resolve artifact references to real storage keys.
   */
  private async buildAssignmentText(
    agent: TcpAgent,
    initialPrompt: string,
  ): Promise<string> {
    const { company, assignment } = agent;
    // The task's implement-mode plan, needed to resolve any
    // `assignment-completed-path` material/expected artifact (a prior step's
    // approved output) — see `resolveArtifactKey`. Only fetched for a task
    // assignment; an orphan (chat/consultation) assignment has no plan.
    const planAssignments = assignment.taskId
      ? (
          await this.assignmentRepo.find({
            where: { taskId: assignment.taskId, mode: 'implement' },
          })
        ).map((a) => ({ orderIndex: a.orderIndex, approved: a.approved }))
      : undefined;

    return buildAssignmentMessage(
      {
        mode: assignment.mode,
        prompt: initialPrompt,
        materials: assignment.materials,
        expected: assignment.expected,
        resolutionContext: {
          companySlug: company.slug,
          task: assignment.task ?? null,
          planAssignments,
          assignment: {
            id: assignment.id,
            taskId: assignment.taskId ?? null,
            orderIndex: assignment.orderIndex ?? null,
          },
        },
      },
      agentPrompts,
    );
  }

  /**
   * Prompt part 4b: the company's role roster, so a plan-mode agent picks a
   * real role by its exact slug rather than inventing one (and, on a wrong
   * guess, create_plan names the valid roles too). Null for every other mode —
   * they assign no roles.
   */
  private async buildRolesMessage(
    assignment: TcpAssignment,
    companyId: TcpRole['companyId'],
  ): Promise<HumanMessage | null> {
    if (assignment.mode !== 'plan') return null;
    const companyRoles = await this.roleRepo.findBy({ companyId });
    const rolesText = buildAvailableRolesMessage(companyRoles);
    return rolesText ? new HumanMessage(rolesText) : null;
  }
}
