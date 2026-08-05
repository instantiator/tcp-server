import type { UUID } from 'crypto';
import { createServer, type AddressInfo } from 'node:net';
import {
  AgentStatus,
  AuditClientService,
  PendingConsultation,
  TcpAgent,
  TcpAssignment,
  TcpCompany,
  TcpRole,
  McpClientService,
  type McpToolContext,
} from '@tcp/shared';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import axios from 'axios';
import { Repository } from 'typeorm';
import { z } from 'zod';
import { AppModule as TcpAgentAppModule } from '../../../apps/tcp-agent/src/app.module';
import { AgentOrchestrationService } from '../../../apps/tcp-server/src/api/agent-orchestration.service';
import { AppModule as TcpServerAppModule } from '../../../apps/tcp-server/src/app.module';
import { requireEnv } from '../../support/require-env';

const STUB_LLM_URL = requireEnv('STUB_LLM_URL');
const INTERNAL_API_KEY = requireEnv('INTERNAL_API_KEY');

/**
 * The whole consultation cycle, driven by the real queue: a caller agent asks
 * another role a question, pauses, and is resumed with the answer once the
 * consulting agent has produced it.
 *
 * Until now this path had no automated coverage at all — it was exercised only
 * by hand via `manual-verify.sh`, which is how a blank-response bug got as far
 * as it did. The cycle spans two services and a BullMQ round trip, so nothing
 * below the integration tier can see it end to end: tcp-server pauses the
 * caller and dispatches the consulting agent, tcp-agent's real worker runs it,
 * its `complete_assignment` call resolves the {@link PendingConsultation}, and
 * tcp-server enqueues the caller's resume carrying the aggregated answer.
 *
 * Only the MCP hop is faked (a mocked `McpClientService.loadTools`, as in
 * `task-flow.integration-spec.ts`) — the fake tools' handlers call exactly the
 * internal endpoints the live MCP servers call, so every server-side state
 * transition is real. Both agents run against the stub LLM, which routes on
 * prompt text, one rule per agent per turn.
 *
 * Run via: ./scripts/run-integration-tests.sh
 */
describe('Consultation cycle (stub LLM, real queue)', () => {
  let serverApp: INestApplication;
  let agentModuleRef: TestingModule;
  let tcpServerUrl: string;
  let loadToolsMock: jest.Mock;

  let companyRepo: Repository<TcpCompany>;
  let roleRepo: Repository<TcpRole>;
  let agentRepo: Repository<TcpAgent>;
  let assignmentRepo: Repository<TcpAssignment>;
  let consultRepo: Repository<PendingConsultation>;
  let orchestration: AgentOrchestrationService;

  let companyId: UUID;
  let callerRoleId: UUID;
  let oracleRoleId: UUID;

  /**
   * The answer the oracle gives. Its only route into the caller's final
   * summary is the resume payload, so seeing it there proves the aggregated
   * consultation result really reached the resumed turn.
   */
  const ORACLE_ANSWER = 'The answer is 42.';

  /** What the caller submits once it has been resumed with the answer. */
  const CALLER_SUMMARY = `Asked the oracle, which said: ${ORACLE_ANSWER}`;

  const internalHeaders = {
    headers: { 'X-Internal-Api-Key': INTERNAL_API_KEY },
  };

  /**
   * Fallback for any prompt no rule matches, applied to every stub config below.
   *
   * The stub 400s on an unmatched prompt, which fails the agent outright and
   * reports it far from the assertion that then times out. This turns that into
   * a legible diff instead.
   *
   * It was added on 2026-08-03 in the belief that the spec's flake came from
   * the two blocks swapping this shared, process-wide config while an agent
   * from the previous block was still running. That diagnosis was wrong: the
   * cause was `collectRepliesSince` comparing the database's clock against the
   * application's, dropping the consultation and resuming the caller with an
   * empty payload — fixed in the service, not here. The fallback earns its
   * place regardless, so it stays.
   *
   * The text is deliberately conspicuous: this response should never reach an
   * assertion, and if it does the diff says so outright.
   */
  const UNMATCHED_PROMPT_FALLBACK = {
    mode: 'loop',
    responses: [{ text: 'stub-llm fallback: no rule matched this prompt' }],
  };

  /**
   * Waits for a consultation to carry its answer.
   *
   * Deliberately accepts `complete` **or** `consumed`: `complete` is transient,
   * because the resume it triggers marks the consultation consumed as soon as
   * the answer has been handed to the calling agent (which is what stops a
   * later resume repeating it). Polling for `complete` alone races that
   * transition. The result reaching the record is the property under test.
   */
  async function waitForResolvedConsultation(
    callingAgentId: UUID,
  ): Promise<PendingConsultation> {
    return waitFor(async () => {
      const found = await consultRepo.findOne({ where: { callingAgentId } });
      if (!found) return null;
      return ['complete', 'consumed'].includes(found.status) ? found : null;
    });
  }

  /** Polls `check` until it returns a truthy value, or throws after `timeoutMs`. */
  async function waitFor<T>(
    check: () => Promise<T | null | undefined | false>,
    timeoutMs = 20_000,
  ): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const result = await check();
      if (result) return result;
      if (Date.now() >= deadline) {
        throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  /**
   * Waits for an agent to reach `expected`, aborting as soon as it settles on
   * any other terminal state.
   *
   * Polling for `Completed` alone cannot distinguish "not there yet" from
   * "already failed, and never will be" — both just run out the clock, and the
   * reason sits in a Nest log line far above the assertion. Failing fast names
   * the state actually reached, so the next occurrence explains itself.
   */
  async function waitForAgentStatus(agentId: UUID, expected: AgentStatus) {
    const settledElsewhere = [
      AgentStatus.Completed,
      AgentStatus.Failed,
      AgentStatus.Cancelled,
    ].filter((status) => status !== expected);

    return waitFor(async () => {
      const found = await agentRepo.findOneBy({ id: agentId });
      if (!found) return null;
      if (settledElsewhere.includes(found.status)) {
        throw new Error(
          `agent ${agentId} settled on ${found.status}, expected ${expected}. ` +
            `output: ${found.output ?? '(none)'}`,
        );
      }
      return found.status === expected ? found : null;
    });
  }

  async function putStubConfig(config: unknown): Promise<void> {
    const res = await fetch(`${STUB_LLM_URL.replace('/v1', '')}/stub/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    });
    if (!res.ok) {
      throw new Error(
        `PUT /stub/config failed: ${res.status} ${await res.text()}`,
      );
    }
  }

  /**
   * A fake `interactions__request_agent_consultation` tool. Its handler is what
   * the live tcp-mcp-interactions server's handler does: `POST /internal/pause`
   * with the identity the MCP client injects from run context, never from the
   * model. The reply deliberately carries no trace of the question, so the
   * caller's own history can't accidentally match the oracle's stub rule.
   */
  function requestConsultationTool(agentId: UUID): DynamicStructuredTool {
    return new DynamicStructuredTool({
      name: 'interactions__request_agent_consultation',
      description: 'Pauses this agent and puts a question to another role.',
      schema: z.object({ roleSlug: z.string(), question: z.string() }),
      func: async ({
        roleSlug,
        question,
      }: {
        roleSlug: string;
        question: string;
      }): Promise<string> => {
        const { data } = await axios.post<{
          consultationId: string;
          roleName: string;
        }>(
          `${tcpServerUrl}/internal/pause`,
          {
            type: 'agent_consultation',
            agentId,
            companyId,
            roleSlug,
            question,
          },
          internalHeaders,
        );
        return `Paused. Consultation ${data.consultationId} dispatched to ${data.roleName}.`;
      },
    });
  }

  /**
   * A fake `tasks__complete_assignment` tool, resolving the agent's assignment
   * through the same internal endpoint the live tcp-mcp-tasks server uses
   * rather than being handed an id the model never sees.
   */
  function completeAssignmentTool(agentId: UUID): DynamicStructuredTool {
    return new DynamicStructuredTool({
      name: 'tasks__complete_assignment',
      description: "Submits the agent's finished assignment.",
      schema: z.object({ summary: z.string() }),
      func: async ({ summary }: { summary: string }): Promise<string> => {
        const { data } = await axios.get<{ assignment: { id: UUID } }>(
          `${tcpServerUrl}/internal/agent/${agentId}/assignment`,
          internalHeaders,
        );
        await axios.post(
          `${tcpServerUrl}/internal/assignment/${data.assignment.id}/complete`,
          { agentId, summary, prepared: [] },
          internalHeaders,
        );
        return 'Assignment completed.';
      },
    });
  }

  /**
   * Grabs a free port synchronously so `TCP_SERVER_URL` is correct *before* any
   * Nest module compiles — `@nestjs/config` snapshots the environment once at
   * `ConfigModule.forRoot()` time (see task-flow.integration-spec.ts).
   */
  async function getFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const probe = createServer();
      probe.listen(0, () => {
        const { port } = probe.address() as AddressInfo;
        probe.close((err) => (err ? reject(err) : resolve(port)));
      });
      probe.on('error', reject);
    });
  }

  beforeAll(async () => {
    const port = await getFreePort();
    tcpServerUrl = `http://127.0.0.1:${port}`;
    process.env.TCP_SERVER_URL = tcpServerUrl;

    const serverModuleRef = await Test.createTestingModule({
      imports: [TcpServerAppModule],
    }).compile();
    serverApp = serverModuleRef.createNestApplication();
    await serverApp.init();
    await serverApp.listen(port);

    companyRepo = serverModuleRef.get(getRepositoryToken(TcpCompany));
    roleRepo = serverModuleRef.get(getRepositoryToken(TcpRole));
    agentRepo = serverModuleRef.get(getRepositoryToken(TcpAgent));
    assignmentRepo = serverModuleRef.get(getRepositoryToken(TcpAssignment));
    consultRepo = serverModuleRef.get(getRepositoryToken(PendingConsultation));
    orchestration = serverModuleRef.get(AgentOrchestrationService);

    // Both agents' tools are built per run from the identity the agent loop
    // passes in, exactly as the real MCP client injects it — so the same mock
    // serves the caller and the oracle without either being handed the other's.
    loadToolsMock = jest.fn(
      (
        _names: string[],
        _urls: Record<string, string>,
        context: McpToolContext,
      ) => {
        const agentId = context.agentId as UUID;
        return Promise.resolve([
          {
            serverName: 'interactions',
            toolName: 'request_agent_consultation',
            tool: requestConsultationTool(agentId),
          },
          {
            serverName: 'tasks',
            toolName: 'complete_assignment',
            tool: completeAssignmentTool(agentId),
          },
        ]);
      },
    );

    agentModuleRef = await Test.createTestingModule({
      imports: [TcpAgentAppModule],
    })
      .overrideProvider(McpClientService)
      .useValue({ loadTools: loadToolsMock })
      // Re-pointed at the real server URL for the same reason as task-flow:
      // tcp-agent's own config snapshot can't pick up an override made after
      // tcp-server's module already triggered env validation.
      .overrideProvider(AuditClientService)
      .useValue({
        notifyComplete: () => {},
        notifyFailed: (agentId: UUID, reason: string) => {
          void axios.post(
            `${tcpServerUrl}/internal/agent/${agentId}/fail`,
            { reason },
            internalHeaders,
          );
        },
        record: () => {},
      })
      .compile();
    // Lifecycle hooks only fire on init — without it AgentWorkerService never
    // creates the BullMQ worker this spec depends on.
    await agentModuleRef.init();

    const company = await companyRepo.save(
      companyRepo.create({
        name: 'Consultation Cycle Co',
        slug: `consultation-co-${Date.now()}`,
        description: 'For consultation-cycle integration tests',
        llmConfig: {
          provider: 'lm-studio',
          model: 'stub',
          baseUrl: STUB_LLM_URL,
        },
      }),
    );
    companyId = company.id;

    const callerRole = await roleRepo.save(
      roleRepo.create({
        companyId,
        slug: 'seeker',
        name: 'Seeker',
        description: 'Asks the oracle',
        systemPromptTemplate: 'You are {{name}}, a seeker.',
      }),
    );
    callerRoleId = callerRole.id;

    const oracleRole = await roleRepo.save(
      roleRepo.create({
        companyId,
        slug: 'oracle',
        name: 'Oracle',
        description: 'Answers questions',
        systemPromptTemplate: 'You are {{name}}, an oracle.',
      }),
    );
    oracleRoleId = oracleRole.id;
  }, 60_000);

  afterAll(async () => {
    await consultRepo.delete({ companyId });
    await agentRepo.delete({ companyId });
    await assignmentRepo.delete({ companyId });
    await roleRepo.delete({ companyId });
    await companyRepo.delete({ id: companyId });
    // Both modules hold their own DB/Redis/BullMQ connections; closing one
    // leaves the other's open and stalls Jest's exit.
    await agentModuleRef.close();
    await serverApp.close();
  });

  /** Removes the agents, assignments and consultations one scenario created. */
  async function clearRuns(): Promise<void> {
    await consultRepo.delete({ companyId });
    await agentRepo.delete({ companyId });
    await assignmentRepo.delete({ companyId });
  }

  describe('when the consulting agent answers after the caller has paused', () => {
    let callerAgentId: UUID;

    beforeAll(async () => {
      // Rules are matched in order against the whole prompt, so the resumed
      // caller's rule must come first: its history still contains the opening
      // ASK-THE-ORACLE marker that started the cycle.
      await putStubConfig({
        prompts: [
          {
            // Only ever matches a caller that was resumed with the answer.
            match: 'Consultation response',
            mode: 'loop',
            responses: [
              {
                text: 'The oracle has answered.',
                tools: [
                  {
                    tool: 'tasks__complete_assignment',
                    data: { summary: CALLER_SUMMARY },
                  },
                ],
              },
            ],
          },
          {
            match: 'ORACLE-QUESTION',
            mode: 'loop',
            responses: [
              {
                text: 'Answering the seeker.',
                tools: [
                  {
                    tool: 'tasks__complete_assignment',
                    data: { summary: ORACLE_ANSWER },
                  },
                ],
              },
            ],
          },
          {
            match: 'ASK-THE-ORACLE',
            mode: 'loop',
            responses: [
              {
                text: 'I will ask the oracle.',
                tools: [
                  {
                    tool: 'interactions__request_agent_consultation',
                    data: {
                      roleSlug: 'oracle',
                      question: 'ORACLE-QUESTION: what is the answer?',
                    },
                  },
                ],
              },
            ],
          },
        ],
        defaults: UNMATCHED_PROMPT_FALLBACK,
      });

      // Dispatched through tcp-server's own orchestration service, so the
      // caller reaches tcp-agent the way a real run does — via the queue.
      const caller = await orchestration.startAgent({
        companyId,
        roleId: callerRoleId,
        initialPrompt: 'ASK-THE-ORACLE for the answer, then submit it.',
      });
      callerAgentId = caller.id;
    }, 60_000);

    afterAll(clearRuns);

    it('resolves the consultation with the consulting agent’s answer', async () => {
      const consultation = await waitForResolvedConsultation(callerAgentId);
      expect(consultation.result).toContain(ORACLE_ANSWER);
    }, 60_000);

    it('resumes the caller with the answer rather than a blank response', async () => {
      const caller = await waitForAgentStatus(
        callerAgentId,
        AgentStatus.Completed,
      );
      // The stub only produces this summary for a prompt containing the
      // aggregated "Consultation response:" text, so the caller demonstrably
      // saw the oracle's answer on resume — the blank-response failure this
      // path was hand-diagnosed for cannot reach here.
      const assignment = await assignmentRepo.findOneByOrFail({
        id: caller.assignmentId,
      });
      expect(assignment.status).toBe('succeeded');
      expect(assignment.summary).toBe(CALLER_SUMMARY);
    }, 60_000);
  });

  describe('when the completion notification arrives after tcp-agent already stored the output', () => {
    let callerAgentId: UUID;
    let oracleAgentId: UUID;

    beforeAll(async () => {
      await putStubConfig({
        prompts: [
          {
            match: 'Consultation response',
            mode: 'loop',
            responses: [
              {
                text: 'The oracle has answered.',
                tools: [
                  {
                    tool: 'tasks__complete_assignment',
                    data: { summary: CALLER_SUMMARY },
                  },
                ],
              },
            ],
          },
        ],
        defaults: UNMATCHED_PROMPT_FALLBACK,
      });

      // The state the race leaves behind: the caller is paused waiting, and
      // the consulting agent has already finished and written its own output
      // (AgentLoopService does that synchronously) before tcp-server hears
      // about it. Built by hand rather than by running the oracle, because the
      // point is the notification that arrives *late* and empty.
      const callerAssignment = await assignmentRepo.save(
        assignmentRepo.create({
          taskId: null,
          companyId,
          roleId: callerRoleId,
          mode: 'implement',
          prompt: 'Waiting on the oracle.',
          status: 'in-progress',
        }),
      );
      const caller = await agentRepo.save(
        agentRepo.create({
          companyId,
          roleId: callerRoleId,
          assignmentId: callerAssignment.id,
          status: AgentStatus.Paused,
          pausedAt: new Date(),
          pauseReason: 'consultation',
          initialPrompt: 'Waiting on the oracle.',
        }),
      );
      callerAgentId = caller.id;
      // The assignment must point back at its agent — `complete_assignment`
      // refuses a submission from an agent the assignment doesn't name.
      await assignmentRepo.update(callerAssignment.id, { agentId: caller.id });

      const oracleAssignment = await assignmentRepo.save(
        assignmentRepo.create({
          taskId: null,
          companyId,
          roleId: oracleRoleId,
          mode: 'consultee',
          prompt: 'Question: what is the answer?',
          status: 'in-progress',
        }),
      );
      const oracle = await agentRepo.save(
        agentRepo.create({
          companyId,
          roleId: oracleRoleId,
          assignmentId: oracleAssignment.id,
          status: AgentStatus.Completed,
          output: ORACLE_ANSWER,
          initialPrompt: 'Question: what is the answer?',
        }),
      );
      oracleAgentId = oracle.id;
      await assignmentRepo.update(oracleAssignment.id, { agentId: oracle.id });

      await consultRepo.save(
        consultRepo.create({
          callingAgentId: callerAgentId,
          consultationAgentId: oracleAgentId,
          companyId,
          status: 'pending',
          result: null,
        }),
      );

      // The late notification, carrying nothing: tcp-server must fall back to
      // the output already on the agent instead of resolving the consultation
      // with an empty string.
      await axios.post(
        `${tcpServerUrl}/internal/agent/${oracleAgentId}/complete`,
        { output: '' },
        internalHeaders,
      );
    }, 60_000);

    afterAll(clearRuns);

    it('resolves the consultation from the stored output instead of the empty notification', async () => {
      const consultation = await waitForResolvedConsultation(callerAgentId);
      expect(consultation.result).toBe(ORACLE_ANSWER);
    });

    it('still resumes the caller, which completes with the answer', async () => {
      const caller = await waitForAgentStatus(
        callerAgentId,
        AgentStatus.Completed,
      );
      const assignment = await assignmentRepo.findOneByOrFail({
        id: caller.assignmentId,
      });
      expect(assignment.summary).toBe(CALLER_SUMMARY);
    }, 60_000);
  });
});
