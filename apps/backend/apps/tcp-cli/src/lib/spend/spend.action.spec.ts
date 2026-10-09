import { apiRequest } from '../core/api';
import { resolveToken } from '../auth/token';
import {
  dismissCapAction,
  dismissNotificationAction,
  notificationsAction,
  restoreCapAction,
  resumeCompanyAction,
  resumeTaskAction,
  usageAction,
} from './spend.action';

jest.mock('../core/api');
jest.mock('../auth/token');

const mockedApiRequest = apiRequest as jest.Mock;
const mockedResolveToken = resolveToken as jest.Mock;

const opts = { tcpServer: 'http://localhost:3000' };
const overview = { trackingSince: null, providers: [], caps: [] };
const companySpend = {
  trackingSince: null,
  providers: [],
  tasks: [],
  series: [],
};

beforeEach(() => {
  jest.clearAllMocks();
  mockedResolveToken.mockResolvedValue('token');
  jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
});

describe('usageAction', () => {
  it('fetches the overview alone when no --company-id is given', async () => {
    mockedApiRequest.mockResolvedValueOnce(overview);

    await usageAction(opts, {});

    expect(mockedApiRequest).toHaveBeenCalledTimes(1);
    expect(mockedApiRequest).toHaveBeenCalledWith(
      expect.anything(),
      'GET',
      '/api/spend',
    );
    expect(process.stdout.write).toHaveBeenCalledWith(
      JSON.stringify(overview, null, 2) + '\n',
    );
  });

  it('merges company spend under `company`, encoding the id/slug path param', async () => {
    mockedApiRequest.mockResolvedValueOnce(overview);
    mockedApiRequest.mockResolvedValueOnce(companySpend);

    await usageAction(opts, { companyId: 'acme co' });

    expect(mockedApiRequest).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      'GET',
      '/api/spend',
    );
    expect(mockedApiRequest).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      'GET',
      '/api/company/acme%20co/spend',
    );
    expect(process.stdout.write).toHaveBeenCalledWith(
      JSON.stringify({ ...overview, company: companySpend }, null, 2) + '\n',
    );
  });
});

describe('notificationsAction', () => {
  it('lists active notifications by default', async () => {
    mockedApiRequest.mockResolvedValueOnce([]);

    await notificationsAction(opts, {});

    expect(mockedApiRequest).toHaveBeenCalledWith(
      expect.anything(),
      'GET',
      '/api/notifications',
    );
  });

  it("lists a company's own notices on its route with --company-id", async () => {
    mockedApiRequest.mockResolvedValueOnce([]);

    await notificationsAction(opts, { companyId: 'c 1', all: true });

    expect(mockedApiRequest).toHaveBeenCalledWith(
      expect.anything(),
      'GET',
      '/api/notifications/company/c%201?includeDismissed',
    );
  });

  it('includes dismissed notifications with --all', async () => {
    mockedApiRequest.mockResolvedValueOnce([]);

    await notificationsAction(opts, { all: true });

    expect(mockedApiRequest).toHaveBeenCalledWith(
      expect.anything(),
      'GET',
      '/api/notifications?includeDismissed',
    );
  });
});

describe('dismissNotificationAction', () => {
  it('posts the dismiss with the encoded notification id', async () => {
    const notification = { id: 'notif-id', severity: 'warning' };
    mockedApiRequest.mockResolvedValueOnce(notification);

    await dismissNotificationAction(opts, { notificationId: 'notif id' });

    expect(mockedApiRequest).toHaveBeenCalledWith(
      expect.anything(),
      'POST',
      '/api/notifications/notif%20id/dismiss',
    );
    expect(process.stdout.write).toHaveBeenCalledWith(
      JSON.stringify(notification, null, 2) + '\n',
    );
  });
});

describe('dismissCapAction', () => {
  it('dismisses until reset by default', async () => {
    const state = { provider: 'lmstudio', dismissal: 'until-reset' };
    mockedApiRequest.mockResolvedValueOnce(state);

    await dismissCapAction(opts, { provider: 'lmstudio' });

    expect(mockedApiRequest).toHaveBeenCalledWith(
      expect.anything(),
      'POST',
      '/api/spend/caps/lmstudio/dismiss',
      { until: 'reset' },
    );
  });

  it('dismisses indefinitely with --indefinitely, encoding the provider id', async () => {
    const state = { provider: 'lm studio', dismissal: 'indefinite' };
    mockedApiRequest.mockResolvedValueOnce(state);

    await dismissCapAction(opts, {
      provider: 'lm studio',
      indefinitely: true,
    });

    expect(mockedApiRequest).toHaveBeenCalledWith(
      expect.anything(),
      'POST',
      '/api/spend/caps/lm%20studio/dismiss',
      { until: 'indefinite' },
    );
  });
});

describe('restoreCapAction', () => {
  it('posts the restore with the encoded provider id', async () => {
    const state = { provider: 'lm studio', dismissal: 'none' };
    mockedApiRequest.mockResolvedValueOnce(state);

    await restoreCapAction(opts, { provider: 'lm studio' });

    expect(mockedApiRequest).toHaveBeenCalledWith(
      expect.anything(),
      'POST',
      '/api/spend/caps/lm%20studio/restore',
    );
  });
});

describe('resumeTaskAction', () => {
  it('posts the resume with the encoded task id', async () => {
    mockedApiRequest.mockResolvedValueOnce({ resumed: 1 });

    await resumeTaskAction(opts, { taskId: 'task id' });

    expect(mockedApiRequest).toHaveBeenCalledWith(
      expect.anything(),
      'POST',
      '/api/task/task%20id/resume',
    );
    expect(process.stdout.write).toHaveBeenCalledWith(
      JSON.stringify({ resumed: 1 }, null, 2) + '\n',
    );
  });
});

describe('resumeCompanyAction', () => {
  it('posts the resume with the encoded company id/slug', async () => {
    mockedApiRequest.mockResolvedValueOnce({ resumed: 3 });

    await resumeCompanyAction(opts, { companyId: 'acme co' });

    expect(mockedApiRequest).toHaveBeenCalledWith(
      expect.anything(),
      'POST',
      '/api/company/acme%20co/resume',
    );
    expect(process.stdout.write).toHaveBeenCalledWith(
      JSON.stringify({ resumed: 3 }, null, 2) + '\n',
    );
  });
});
