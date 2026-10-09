import { TcpCompany, TcpNotification, type WireEvent } from '@tcp/shared';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import { App } from 'supertest/types';
import { Repository } from 'typeorm';
import { AppModule } from '../../../apps/tcp-server/src/app.module';
import { NotificationService } from '../../../apps/tcp-server/src/notifications/notification.service';
import { consumeSse } from '../helpers/consume-sse';
import { makeTestJwt } from '../helpers/test-jwt';

/** The notification payloads among `events`, in arrival order. */
const notificationPayloads = (events: WireEvent[]): Record<string, unknown>[] =>
  events.flatMap((e) =>
    e.type === 'audit' && e.event.payload.entity === 'notification'
      ? [e.event.payload]
      : [],
  );

/**
 * Exercises `/api/notifications` and the notification fan-out onto company
 * SSE streams over real HTTP, Postgres and Redis — including the unique
 * `dedupeKey` constraint that makes concurrent raises of one condition
 * collapse to a single row.
 */
describe('Notifications (e2e)', () => {
  let app: INestApplication<App>;
  let notifications: NotificationService;
  let notificationRepo: Repository<TcpNotification>;
  let companyRepo: Repository<TcpCompany>;
  let auth: { Authorization: string };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.listen(0);

    notifications = moduleFixture.get(NotificationService);
    notificationRepo = moduleFixture.get(getRepositoryToken(TcpNotification));
    companyRepo = moduleFixture.get(getRepositoryToken(TcpCompany));
    auth = { Authorization: `Bearer ${makeTestJwt()}` };
  });

  afterEach(async () => {
    await notificationRepo.createQueryBuilder().delete().execute();
  });

  afterAll(async () => {
    await companyRepo.createQueryBuilder().delete().execute();
    await app.close();
  });

  it('requires a signed-in user', async () => {
    await request(app.getHttpServer()).get('/api/notifications').expect(401);
  });

  it('lists active notifications, and dismissed ones only on request', async () => {
    const kept = await notifications.create({
      severity: 'warning',
      kind: 'spend_threshold',
      message: 'kept',
    });
    const gone = await notifications.create({
      severity: 'info',
      kind: 'spend_reset',
      message: 'gone',
    });

    await request(app.getHttpServer())
      .post(`/api/notifications/${gone?.id}/dismiss`)
      .set(auth)
      .expect(200);

    const active = await request(app.getHttpServer())
      .get('/api/notifications')
      .set(auth)
      .expect(200);
    expect((active.body as TcpNotification[]).map((n) => n.id)).toEqual([
      kept?.id,
    ]);

    const all = await request(app.getHttpServer())
      .get('/api/notifications?includeDismissed')
      .set(auth)
      .expect(200);
    expect(all.body).toHaveLength(2);
  });

  describe("a company's own notices", () => {
    const stranger = {
      Authorization: `Bearer ${makeTestJwt({ sub: 'notice-stranger' })}`,
    };

    /** A company the default test user created, so is a member of. */
    async function ownCompany(): Promise<TcpCompany> {
      const res = await request(app.getHttpServer())
        .post('/api/company')
        .set(auth)
        .send({
          slug: `noticeco-${Date.now()}`,
          name: 'Notice Co',
          description: 'test',
        })
        .expect(201);
      return res.body as TcpCompany;
    }

    it('shows them to its members beside the application-wide ones, and nowhere else', async () => {
      const company = await ownCompany();
      const wide = await notifications.create({
        severity: 'warning',
        kind: 'spend_threshold',
        message: 'wide',
      });
      const own = await notifications.create({
        severity: 'error',
        kind: 'task_failed',
        message: 'Task 000 failed.',
        companyId: company.id,
      });

      const forCompany = await request(app.getHttpServer())
        .get(`/api/notifications/company/${company.id}`)
        .set(auth)
        .expect(200);
      expect(
        (forCompany.body as TcpNotification[]).map((n) => n.id).sort(),
      ).toEqual([wide?.id, own?.id].sort());

      const global = await request(app.getHttpServer())
        .get('/api/notifications')
        .set(auth)
        .expect(200);
      expect((global.body as TcpNotification[]).map((n) => n.id)).toEqual([
        wide?.id,
      ]);

      await request(app.getHttpServer())
        .get(`/api/notifications/company/${company.id}`)
        .set(stranger)
        .expect(403);
    });

    it('lets only its members dismiss them; to anyone else they do not exist', async () => {
      const company = await ownCompany();
      const own = await notifications.create({
        severity: 'error',
        kind: 'task_failed',
        message: 'Task 000 failed.',
        companyId: company.id,
      });

      await request(app.getHttpServer())
        .post(`/api/notifications/${own?.id}/dismiss`)
        .set(stranger)
        .expect(404);
      await request(app.getHttpServer())
        .post(`/api/notifications/${own?.id}/dismiss`)
        .set(auth)
        .expect(200);
    });
  });

  it('404s when dismissing an unknown notification', async () => {
    await request(app.getHttpServer())
      .post('/api/notifications/00000000-0000-4000-8000-000000000000/dismiss')
      .set(auth)
      .expect(404);
  });

  it('raises one row when the same dedupe key is raised concurrently', async () => {
    const raise = () =>
      notifications.create({
        severity: 'error',
        kind: 'spend_reached',
        message: 'cap reached',
        dedupeKey: 'cap:anthropic:month:2026-10-01:100',
      });

    const results = await Promise.all([raise(), raise(), raise()]);

    expect(results.filter((r) => r !== null)).toHaveLength(1);
    expect(await notificationRepo.count()).toBe(1);
  });

  it('primes a company stream with active notifications, then pushes new ones and dismissals live', async () => {
    const company = (
      await request(app.getHttpServer())
        .post('/api/company')
        .set(auth)
        .send({
          slug: `notify-co-${Date.now()}`,
          name: 'Notify Co',
          description: 'test',
        })
        .expect(201)
    ).body as TcpCompany;
    const primed = await notifications.create({
      severity: 'warning',
      kind: 'spend_threshold',
      message: 'already here',
    });

    // Priming: company + the active notification; live: one raise, one dismissal.
    const events$ = consumeSse<WireEvent>(
      app,
      `/api/company/${company.id}/events`,
      auth,
      4,
    );
    await new Promise((resolve) => setTimeout(resolve, 300));

    const raised = await notifications.create({
      severity: 'error',
      kind: 'spend_reached',
      message: 'live',
    });
    await notifications.dismiss(primed!.id);

    const payloads = notificationPayloads(await events$);
    expect(payloads.map((p) => [p.reason, p.newStatus])).toEqual([
      ['replay', 'active'],
      ['change', 'active'],
      ['change', 'dismissed'],
    ]);
    expect(payloads.map((p) => (p.summary as TcpNotification).id)).toEqual([
      primed?.id,
      raised?.id,
      primed?.id,
    ]);
  });
});
