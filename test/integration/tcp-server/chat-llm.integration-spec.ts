import {
  AgentStatus,
  AuditEvent,
  AuditEventType,
  TcpAgent,
  TcpAssignment,
  TcpCompany,
  TcpRole,
  TcpTask,
  McpClientService,
  MODE_PROMPTS,
  WireEvent,
} from '@tcp/shared';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { getRepositoryToken, TypeOrmModule } from '@nestjs/typeorm';
import { UUID } from 'crypto';
import { DataSource, Repository } from 'typeorm';
import { ChatTurnEnvironmentService } from '../../../apps/tcp-server/src/api/chat-turn-environment.service';
import { ChatTurnPromptService } from '../../../apps/tcp-server/src/api/chat-turn-prompt.service';
import { ChatService } from '../../../apps/tcp-server/src/api/chat.service';
import { AuditModule } from '../../../apps/tcp-server/src/audit/audit.module';
import { ContextModule } from '../../../apps/tcp-server/src/context/context.module';
import { AgentEventService } from '../../../apps/tcp-server/src/events/agent-event.service';
import { KnowledgeRetrievalService } from '@tcp/shared';
import { requireEnv } from '../../support/require-env';

const TERMINAL_STATUSES = ['completed', 'failed', 'idle', 'cancelled'];

/** True for a terminal agent `state_change` WireEvent. */
function isTerminalAgentEvent(e: WireEvent): boolean {
  return (
    e.type === 'audit' &&
    e.event.eventType === AuditEventType.StateChange &&
    e.event.payload.entity === 'agent' &&
    TERMINAL_STATUSES.includes(String(e.event.payload.newStatus))
  );
}

/**
 * Integration tests for {@link ChatService} against a live PostgreSQL instance
 * and a stub LLM service. Both are provisioned by the integration global setup,
 * so DATABASE_URL and STUB_LLM_URL are always present.
 *
 * Run via: ./scripts/run-integration-tests.sh
 */

const STUB_LLM_URL = requireEnv('STUB_LLM_URL');
const DATABASE_URL = requireEnv('DATABASE_URL');

/**
 * Configures the stub to answer every prompt with `response`. `loop` mode
 * (rather than the default `sequence`) means repeated calls within one test
 * keep returning the same text rather than erroring once "exhausted".
 */
async function setStubResponse(response: string): Promise<void> {
  await fetch(`${STUB_LLM_URL.replace('/v1', '')}/stub/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      defaults: { mode: 'loop', responses: [{ text: response, tools: [] }] },
    }),
  });
}

describe('ChatService integration (stub LLM)', () => {
  let service: ChatService;
  let agentEvents: AgentEventService;
  let agentRepo: Repository<TcpAgent>;
  let assignmentRepo: Repository<TcpAssignment>;
  let roleRepo: Repository<TcpRole>;
  let companyRepo: Repository<TcpCompany>;
  let auditRepo: Repository<AuditEvent>;
  let dataSource: DataSource;
  let testCompanyId: UUID;
  let testRoleId: UUID;

  /**
   * Resolves with the agent's terminal event. The turn now runs detached and
   * delivers its outcome over the event stream rather than a return value.
   */
  function waitForTerminal(agentId: UUID): Promise<WireEvent> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('timed out waiting for terminal event')),
        30_000,
      );
      const sub = agentEvents.observe(agentId).subscribe((event) => {
        if (isTerminalAgentEvent(event)) {
          clearTimeout(timer);
          sub.unsubscribe();
          resolve(event);
        }
      });
    });
  }

  /** Orphan chat-mode assignment for a chat agent's mandatory FK. */
  function seedAssignment() {
    return assignmentRepo.save(
      assignmentRepo.create({
        taskId: null,
        companyId: testCompanyId,
        roleId: testRoleId,
        mode: 'chat',
        prompt: '',
        status: 'in-progress',
      }),
    );
  }

  /** Reads the body of the last chat-completion request the stub received. */
  async function lastChatRequest(): Promise<{
    messages: { role: string; content: string }[];
  } | null> {
    const res = await fetch(
      `${STUB_LLM_URL.replace('/v1', '')}/stub/last-request`,
    );
    return res.json() as Promise<{
      messages: { role: string; content: string }[];
    } | null>;
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        TypeOrmModule.forRoot({
          type: 'postgres',
          url: DATABASE_URL,
          entities: [
            TcpAgent,
            TcpRole,
            TcpCompany,
            TcpTask,
            TcpAssignment,
            AuditEvent,
          ],
          synchronize: true,
        }),
        TypeOrmModule.forFeature([
          TcpAgent,
          TcpRole,
          TcpCompany,
          TcpTask,
          TcpAssignment,
          AuditEvent,
        ]),
        ContextModule,
        AuditModule,
      ],
      providers: [
        ChatService,
        ChatTurnEnvironmentService,
        ChatTurnPromptService,
        // AuditService + AgentEventService + AuditEventPublisher come from
        // AuditModule (which re-exports EventsModule), so ChatService, the
        // persist-then-publish path, and this test all share one wiring — the
        // event stream is how the detached turn reports completion.
        {
          provide: KnowledgeRetrievalService,
          useValue: { retrieve: jest.fn().mockResolvedValue([]) },
        },
        {
          provide: McpClientService,
          useValue: { loadTools: jest.fn().mockResolvedValue([]) },
        },
      ],
    }).compile();

    service = moduleRef.get(ChatService);
    agentEvents = moduleRef.get(AgentEventService);
    agentRepo = moduleRef.get(getRepositoryToken(TcpAgent));
    assignmentRepo = moduleRef.get(getRepositoryToken(TcpAssignment));
    roleRepo = moduleRef.get(getRepositoryToken(TcpRole));
    companyRepo = moduleRef.get(getRepositoryToken(TcpCompany));
    auditRepo = moduleRef.get(getRepositoryToken(AuditEvent));
    dataSource = moduleRef.get(DataSource);

    // Seed a company and role pointing to the stub LLM
    const company = await companyRepo.save(
      companyRepo.create({
        name: 'Integration Test Co',
        slug: 'test-co',
        description: 'For integration tests',
        llmConfig: {
          provider: 'lm-studio',
          model: 'stub',
          baseUrl: STUB_LLM_URL,
        },
      }),
    );
    testCompanyId = company.id;

    const role = await roleRepo.save(
      roleRepo.create({
        companyId: testCompanyId,
        slug: 'stub-analyst',
        name: 'stub-analyst',
        description: 'Stub test role',
        systemPromptTemplate: 'You are {{name}}, an analyst.',
      }),
    );
    testRoleId = role.id;
  });

  afterAll(async () => {
    if (!dataSource?.isInitialized) return;
    // Clean up test fixtures
    await auditRepo.delete({ companyId: testCompanyId });
    await agentRepo.delete({ companyId: testCompanyId });
    await assignmentRepo.delete({ companyId: testCompanyId });
    await roleRepo.delete({ companyId: testCompanyId });
    await companyRepo.delete({ id: testCompanyId });
    await agentEvents.onModuleDestroy();
    await dataSource.destroy();
  });

  it('streams a message end-to-end and completes with the stub response', async () => {
    await setStubResponse('Hello from stub LLM!');

    const assignment = await seedAssignment();
    const agent = await agentRepo.save(
      agentRepo.create({
        companyId: testCompanyId,
        roleId: testRoleId,
        assignmentId: assignment.id,
        status: AgentStatus.Idle,
        initialPrompt: '',
      }),
    );

    try {
      const terminal = waitForTerminal(agent.id);
      await service.sendMessage(agent.id, 'Hi there');
      const event = await terminal;

      expect(event.type).toBe('audit');
      if (event.type === 'audit') {
        expect(event.event.payload.newStatus).toBe(AgentStatus.Idle);
        expect(event.event.payload.response).toBe('Hello from stub LLM!');
      }

      // The response is also persisted for the recovery/replay path.
      const updated = await agentRepo.findOneBy({ id: agent.id });
      expect(updated?.status).toBe(AgentStatus.Idle);
      expect(updated?.output).toBe('Hello from stub LLM!');

      // The first turn now carries the chat mode prompt as part 4, so the chat
      // agent knows it is in a conversation (not a bare user message).
      const req = await lastChatRequest();
      const promptText = (req?.messages ?? []).map((m) => m.content).join('\n');
      expect(promptText).toContain(MODE_PROMPTS.chat);
      expect(promptText).toContain('Hi there');
    } finally {
      await agentRepo.delete({ id: agent.id });
    }
  });

  it('writes LlmRequest and LlmResponse audit events', async () => {
    await setStubResponse('Audit test response');

    const assignment = await seedAssignment();
    const agent = await agentRepo.save(
      agentRepo.create({
        companyId: testCompanyId,
        roleId: testRoleId,
        assignmentId: assignment.id,
        status: AgentStatus.Idle,
        initialPrompt: '',
      }),
    );

    try {
      const terminal = waitForTerminal(agent.id);
      await service.sendMessage(agent.id, 'Audit test');
      await terminal;

      const events = await auditRepo.find({
        where: { agentId: agent.id },
        order: { timestamp: 'ASC' },
      });

      const types = events.map((e) => e.eventType);
      expect(types).toContain(AuditEventType.LlmRequest);
      expect(types).toContain(AuditEventType.LlmResponse);
    } finally {
      await auditRepo.delete({ agentId: agent.id });
      await agentRepo.delete({ id: agent.id });
    }
  });
});
