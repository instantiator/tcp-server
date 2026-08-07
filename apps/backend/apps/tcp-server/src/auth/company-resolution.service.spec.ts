import { Conversation, TcpAssignment, TcpTask } from '@tcp/shared';
import { NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { Request } from 'express';
import { ObjectLiteral, Repository } from 'typeorm';
import { DbService } from '../db/db.service';
import { CompanyResolutionService } from './company-resolution.service';
import type { CompanyScopeSpec } from './company-scope.decorator';

const COMPANY_ID = randomUUID();

const fakeReq = (parts: {
  params?: Record<string, unknown>;
  query?: Record<string, unknown>;
  body?: unknown;
}): Request =>
  ({
    params: parts.params ?? {},
    query: parts.query ?? {},
    body: parts.body ?? {},
  }) as unknown as Request;

const makeDb = (): jest.Mocked<
  Pick<DbService, 'getCompany' | 'getAgent' | 'getRole'>
> => ({
  getCompany: jest.fn().mockResolvedValue({ id: COMPANY_ID }),
  getAgent: jest.fn().mockResolvedValue({ companyId: COMPANY_ID }),
  getRole: jest.fn().mockResolvedValue({ companyId: COMPANY_ID }),
});

const makeRepo = <T extends ObjectLiteral>(): jest.Mocked<
  Pick<Repository<T>, 'findOneBy'>
> => ({
  findOneBy: jest.fn().mockResolvedValue({ companyId: COMPANY_ID }),
});

const make = () => {
  const db = makeDb();
  const taskRepo = makeRepo<TcpTask>();
  const assignmentRepo = makeRepo<TcpAssignment>();
  const conversationRepo = makeRepo<Conversation>();
  return {
    db,
    taskRepo,
    assignmentRepo,
    conversationRepo,
    service: new CompanyResolutionService(
      db as unknown as DbService,
      taskRepo as unknown as Repository<TcpTask>,
      assignmentRepo as unknown as Repository<TcpAssignment>,
      conversationRepo as unknown as Repository<Conversation>,
    ),
  };
};

describe('CompanyResolutionService', () => {
  describe('by entity', () => {
    const id = randomUUID();

    it.each<[CompanyScopeSpec['via'], Request]>([
      ['company', fakeReq({ params: { key: id } })],
      ['task', fakeReq({ params: { key: id } })],
      ['assignment', fakeReq({ params: { key: id } })],
      ['agent', fakeReq({ params: { key: id } })],
      ['role', fakeReq({ params: { key: id } })],
      ['conversation', fakeReq({ params: { key: 'analyst-1' } })],
    ])('resolves the owning company via %s', async (via, req) => {
      const { service } = make();
      await expect(
        service.resolve(req, [{ from: 'param', key: 'key', via }]),
      ).resolves.toBe(COMPANY_ID);
    });

    it('reads a handle from the query string', async () => {
      const { service } = make();
      await expect(
        service.resolve(fakeReq({ query: { companyId: id } }), [
          { from: 'query', key: 'companyId', via: 'company' },
        ]),
      ).resolves.toBe(COMPANY_ID);
    });

    it('reads a handle from the body', async () => {
      const { service } = make();
      await expect(
        service.resolve(fakeReq({ body: { companyId: id } }), [
          { from: 'body', key: 'companyId', via: 'company' },
        ]),
      ).resolves.toBe(COMPANY_ID);
    });
  });

  describe('when the handle names nothing', () => {
    // A 404, never a membership failure: the two must stay distinguishable,
    // or a genuine permissions problem reads as a missing record.
    it('throws NotFound for an unknown company', async () => {
      const { service, db } = make();
      db.getCompany.mockResolvedValue(null);
      await expect(
        service.resolve(fakeReq({ params: { id: 'ghost' } }), [
          { from: 'param', key: 'id', via: 'company' },
        ]),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('throws NotFound for an unknown task', async () => {
      const { service, taskRepo } = make();
      taskRepo.findOneBy.mockResolvedValue(null);
      await expect(
        service.resolve(fakeReq({ params: { id: randomUUID() } }), [
          { from: 'param', key: 'id', via: 'task' },
        ]),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    // The id columns are typed `uuid`: querying a malformed value would
    // surface as a database error rather than a 404.
    it('throws NotFound for a malformed UUID without querying', async () => {
      const { service, taskRepo } = make();
      await expect(
        service.resolve(fakeReq({ params: { id: 'not-a-uuid' } }), [
          { from: 'param', key: 'id', via: 'task' },
        ]),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(taskRepo.findOneBy).not.toHaveBeenCalled();
    });
  });

  describe('storage paths', () => {
    it('resolves the company from the first key segment', async () => {
      const { service, db } = make();
      await expect(
        service.resolve(
          fakeReq({ query: { path: 'acme/knowledge/shared/x.md' } }),
          [{ from: 'query', key: 'path', via: 'storagePath' }],
        ),
      ).resolves.toBe(COMPANY_ID);
      expect(db.getCompany).toHaveBeenCalledWith('acme');
    });

    // A pattern in the company segment names no single company; the guard
    // refuses it rather than letting it span every company's storage.
    it.each(['*/knowledge/x.md', 'ac?e/knowledge/x.md'])(
      'resolves nothing for the glob %p',
      async (path) => {
        const { service } = make();
        await expect(
          service.resolve(fakeReq({ query: { path } }), [
            { from: 'query', key: 'path', via: 'storagePath' },
          ]),
        ).resolves.toBeNull();
      },
    );
  });

  describe('when no handle is present', () => {
    it('returns null rather than guessing', async () => {
      const { service } = make();
      await expect(
        service.resolve(fakeReq({}), [
          { from: 'query', key: 'companyId', via: 'company' },
        ]),
      ).resolves.toBeNull();
    });

    // A repeated query parameter arrives as an array, a nested body field as
    // an object. Neither is a handle, and coercing one would invent a company.
    it.each([
      ['an array', ['a', 'b']],
      ['an object', { nested: true }],
      ['an empty string', ''],
    ])('treats %s as absent', async (_label, value) => {
      const { service } = make();
      await expect(
        service.resolve(fakeReq({ query: { companyId: value } }), [
          { from: 'query', key: 'companyId', via: 'company' },
        ]),
      ).resolves.toBeNull();
    });

    it('skips a spec whose value is in its ignore list', async () => {
      const { service, taskRepo } = make();
      await expect(
        service.resolve(fakeReq({ query: { taskId: 'null' } }), [
          { from: 'query', key: 'taskId', via: 'task', ignore: ['null'] },
        ]),
      ).resolves.toBeNull();
      expect(taskRepo.findOneBy).not.toHaveBeenCalled();
    });
  });

  describe('with several specs', () => {
    it('uses the first one present, in declaration order', async () => {
      const { service, db, taskRepo } = make();
      await service.resolve(
        fakeReq({ query: { taskId: randomUUID(), companyId: randomUUID() } }),
        [
          { from: 'query', key: 'companyId', via: 'company' },
          { from: 'query', key: 'taskId', via: 'task' },
        ],
      );
      expect(db.getCompany).toHaveBeenCalled();
      expect(taskRepo.findOneBy).not.toHaveBeenCalled();
    });

    it('falls through to a later spec when the earlier one is absent', async () => {
      const { service, taskRepo } = make();
      const taskId = randomUUID();
      await expect(
        service.resolve(fakeReq({ query: { taskId } }), [
          { from: 'query', key: 'companyId', via: 'company' },
          { from: 'query', key: 'taskId', via: 'task' },
        ]),
      ).resolves.toBe(COMPANY_ID);
      expect(taskRepo.findOneBy).toHaveBeenCalledWith({ id: taskId });
    });
  });

  it('resolves an agent through the shared DbService', async () => {
    const { service, db } = make();
    const agentId = randomUUID();
    await service.resolve(fakeReq({ params: { id: agentId } }), [
      { from: 'param', key: 'id', via: 'agent' },
    ]);
    expect(db.getAgent).toHaveBeenCalledWith(agentId);
  });

  it('resolves a conversation by slug', async () => {
    const { service, conversationRepo } = make();
    await service.resolve(fakeReq({ params: { slug: 'analyst-3' } }), [
      { from: 'param', key: 'slug', via: 'conversation' },
    ]);
    expect(conversationRepo.findOneBy).toHaveBeenCalledWith({
      slug: 'analyst-3',
    });
  });

  it('throws NotFound for an unknown conversation slug', async () => {
    const { service, conversationRepo } = make();
    conversationRepo.findOneBy.mockResolvedValue(null);
    await expect(
      service.resolve(fakeReq({ params: { slug: 'ghost-1' } }), [
        { from: 'param', key: 'slug', via: 'conversation' },
      ]),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('never resolves an agent that does not exist', async () => {
    const { service, db } = make();
    db.getAgent.mockResolvedValue(null);
    await expect(
      service.resolve(fakeReq({ params: { id: randomUUID() } }), [
        { from: 'param', key: 'id', via: 'agent' },
      ]),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
