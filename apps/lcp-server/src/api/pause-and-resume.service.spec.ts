import {
  AgentStatus,
  LcpAgent,
  LcpRole,
  PendingConsultation,
} from '@lcp/shared';
import { NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { Repository } from 'typeorm';
import { AgentOrchestrationService } from './agent-orchestration.service';
import { ConversationService } from './conversation.service';
import { PauseAndResumeService } from './pause-and-resume.service';

const makeRepo = <T extends object>(): jest.Mocked<
  Pick<Repository<T>, 'findOneBy' | 'findOne' | 'update' | 'create' | 'save'>
> => ({
  findOneBy: jest.fn().mockResolvedValue(null),
  findOne: jest.fn().mockResolvedValue(null),
  update: jest.fn().mockResolvedValue({ affected: 1 }),
  create: jest.fn().mockImplementation((d) => d as T),
  save: jest.fn().mockImplementation((e) => Promise.resolve(e as T)),
});

const makeAgent = (overrides: Partial<LcpAgent> = {}): LcpAgent => ({
  id: randomUUID(),
  companyId: randomUUID(),
  roleId: randomUUID(),
  status: AgentStatus.Running,
  threadId: null,
  initialPrompt: 'Do stuff.',
  output: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  company: {} as never,
  role: {} as never,
  version: 1,
  ...overrides,
});

const makeRole = (overrides: Partial<LcpRole> = {}): LcpRole =>
  ({
    id: randomUUID(),
    companyId: randomUUID(),
    name: 'analyst',
    ...overrides,
  }) as LcpRole;

describe('PauseAndResumeService', () => {
  let agentRepo: ReturnType<typeof makeRepo<LcpAgent>>;
  let roleRepo: ReturnType<typeof makeRepo<LcpRole>>;
  let consultRepo: ReturnType<typeof makeRepo<PendingConsultation>>;
  let convService: { create: jest.Mock };
  let orchestration: { startAgent: jest.Mock; resumeAgent: jest.Mock };
  let service: PauseAndResumeService;

  beforeEach(() => {
    agentRepo = makeRepo();
    roleRepo = makeRepo();
    consultRepo = makeRepo();
    convService = { create: jest.fn() };
    orchestration = {
      startAgent: jest.fn(),
      resumeAgent: jest.fn().mockResolvedValue(undefined),
    };

    service = new PauseAndResumeService(
      agentRepo as unknown as Repository<LcpAgent>,
      roleRepo as unknown as Repository<LcpRole>,
      consultRepo as unknown as Repository<PendingConsultation>,
      convService as unknown as ConversationService,
      orchestration as unknown as AgentOrchestrationService,
    );
  });

  describe('pauseForUserInput', () => {
    it('throws NotFoundException when agent does not exist', async () => {
      agentRepo.findOneBy.mockResolvedValue(null);
      await expect(
        service.pauseForUserInput(randomUUID(), 'What is the plan?'),
      ).rejects.toThrow(NotFoundException);
    });

    it('sets agent status to Paused and creates a conversation', async () => {
      const agent = makeAgent();
      const role = makeRole({ id: agent.roleId, name: 'analyst' });
      agentRepo.findOneBy.mockResolvedValue(agent);
      roleRepo.findOneBy.mockResolvedValue(role);
      convService.create.mockResolvedValue({ slug: 'analyst-1' });

      const result = await service.pauseForUserInput(
        agent.id,
        'What is the plan?',
        'Some context',
      );

      expect(agentRepo.update).toHaveBeenCalledWith(agent.id, {
        status: AgentStatus.Paused,
      });
      expect(convService.create).toHaveBeenCalledWith(
        agent.companyId,
        agent.roleId,
        'analyst',
        agent.id,
        'What is the plan?',
        'Some context',
      );
      expect(result.slug).toBe('analyst-1');
    });

    it('falls back to "agent" as role name when role not found', async () => {
      const agent = makeAgent();
      agentRepo.findOneBy.mockResolvedValue(agent);
      roleRepo.findOneBy.mockResolvedValue(null);
      convService.create.mockResolvedValue({ slug: 'agent-0' });

      await service.pauseForUserInput(agent.id, 'question');

      expect(convService.create).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        'agent',
        expect.any(String),
        'question',
        undefined,
      );
    });
  });

  describe('pauseForConsultation', () => {
    it('throws NotFoundException when role does not exist for the company', async () => {
      const agent = makeAgent();
      agentRepo.findOneBy.mockResolvedValue(agent);
      roleRepo.findOne.mockResolvedValue(null);

      await expect(
        service.pauseForConsultation(
          agent.id,
          agent.companyId,
          'unknown-role',
          'question',
        ),
      ).rejects.toThrow(NotFoundException);
    });

    it('sets calling agent to Paused, starts consultation agent, creates PendingConsultation', async () => {
      const caller = makeAgent();
      const callerRole = makeRole({ id: caller.roleId, name: 'cto' });
      const consultRole = makeRole({
        name: 'analyst',
        companyId: caller.companyId,
      });
      const consultAgent = makeAgent({ id: randomUUID() });

      agentRepo.findOneBy
        .mockResolvedValueOnce(caller) // loadAgent(callingAgentId)
        .mockResolvedValueOnce(callerRole as never); // findOneBy({id: callingAgent.roleId})

      roleRepo.findOne.mockResolvedValue(consultRole);
      roleRepo.findOneBy.mockResolvedValue(callerRole);
      orchestration.startAgent.mockResolvedValue(consultAgent);
      consultRepo.save.mockResolvedValue({
        id: randomUUID(),
        callingAgentId: caller.id,
        consultationAgentId: consultAgent.id,
        companyId: caller.companyId,
        status: 'pending',
        result: null,
        createdAt: new Date(),
        version: 1,
      });

      await service.pauseForConsultation(
        caller.id,
        caller.companyId,
        'analyst',
        'Can you analyse this?',
      );

      expect(agentRepo.update).toHaveBeenCalledWith(caller.id, {
        status: AgentStatus.Paused,
      });
      expect(orchestration.startAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          companyId: caller.companyId,
          roleId: consultRole.id,
        }),
      );
      expect(consultRepo.save).toHaveBeenCalled();
    });
  });

  describe('completeAgent', () => {
    it('is a no-op when agent does not exist', async () => {
      agentRepo.findOneBy.mockResolvedValue(null);
      await expect(
        service.completeAgent(randomUUID(), 'output'),
      ).resolves.not.toThrow();
      expect(agentRepo.update).not.toHaveBeenCalled();
    });

    it('is a no-op when agent is already Completed', async () => {
      const agent = makeAgent({ status: AgentStatus.Completed });
      agentRepo.findOneBy.mockResolvedValue(agent);

      await service.completeAgent(agent.id, 'output');

      expect(agentRepo.update).not.toHaveBeenCalled();
    });

    it('sets status to Completed with output', async () => {
      const agent = makeAgent({ status: AgentStatus.Running });
      agentRepo.findOneBy.mockResolvedValue(agent);
      consultRepo.findOne.mockResolvedValue(null);

      await service.completeAgent(agent.id, 'final answer');

      expect(agentRepo.update).toHaveBeenCalledWith(agent.id, {
        status: AgentStatus.Completed,
        output: 'final answer',
      });
    });

    it('resolves PendingConsultation and resumes calling agent when one exists', async () => {
      const consultAgent = makeAgent({ status: AgentStatus.Running });
      const callingAgent = makeAgent({ status: AgentStatus.Paused });
      const consultation = {
        id: randomUUID(),
        callingAgentId: callingAgent.id,
        consultationAgentId: consultAgent.id,
        companyId: callingAgent.companyId,
        status: 'pending',
        result: null,
        createdAt: new Date(),
      } as PendingConsultation;

      agentRepo.findOneBy
        .mockResolvedValueOnce(consultAgent) // load consultAgent
        .mockResolvedValueOnce(callingAgent); // load callingAgent

      consultRepo.findOne.mockResolvedValue(consultation);

      await service.completeAgent(consultAgent.id, 'consultation result');

      expect(consultRepo.update).toHaveBeenCalledWith(consultation.id, {
        status: 'complete',
        result: 'consultation result',
      });
      expect(orchestration.resumeAgent).toHaveBeenCalledWith(
        callingAgent.id,
        'consultation result',
      );
    });

    it('does not resume calling agent when it is not Paused', async () => {
      const consultAgent = makeAgent({ status: AgentStatus.Running });
      const callingAgent = makeAgent({ status: AgentStatus.Completed });
      const consultation = {
        id: randomUUID(),
        callingAgentId: callingAgent.id,
        consultationAgentId: consultAgent.id,
        companyId: callingAgent.companyId,
        status: 'pending',
        result: null,
        createdAt: new Date(),
      } as PendingConsultation;

      agentRepo.findOneBy
        .mockResolvedValueOnce(consultAgent)
        .mockResolvedValueOnce(callingAgent);
      consultRepo.findOne.mockResolvedValue(consultation);

      await service.completeAgent(consultAgent.id, 'result');

      expect(orchestration.resumeAgent).not.toHaveBeenCalled();
    });
  });
});
