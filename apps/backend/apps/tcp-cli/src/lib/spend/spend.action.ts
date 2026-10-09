import type {
  CompanySpend,
  ResumeResult,
  SpendCapState,
  SpendOverview,
  TcpNotification,
} from '@tcp/shared';
import { apiOptions, GlobalOptions } from '../core/cli-options';
import { apiRequest } from '../core/api';
import { runCommand } from '../core/run-command';
import { resolveToken } from '../auth/token';

/**
 * Reports application-wide spend: caps, usage and totals. With `--company-id`,
 * also fetches that company's own usage and merges it under `company`.
 *
 * stdout: `SpendOverview`, or `SpendOverview & { company: CompanySpend }`.
 */
export function usageAction(
  opts: GlobalOptions,
  cmdOpts: { companyId?: string },
): Promise<void> {
  return runCommand(async () => {
    const token = await resolveToken({ ...opts, baseUrl: opts.tcpServer });
    const api = apiOptions(opts, token);

    const overview = await apiRequest<SpendOverview>(api, 'GET', '/api/spend');
    if (!cmdOpts.companyId) {
      process.stdout.write(JSON.stringify(overview, null, 2) + '\n');
      return;
    }

    const company = await apiRequest<CompanySpend>(
      api,
      'GET',
      `/api/company/${encodeURIComponent(cmdOpts.companyId)}/spend`,
    );
    process.stdout.write(
      JSON.stringify({ ...overview, company }, null, 2) + '\n',
    );
  });
}

/** Lists notifications; `--all` includes already-dismissed ones. stdout: `TcpNotification[]`. */
export function notificationsAction(
  opts: GlobalOptions,
  cmdOpts: { all?: boolean; companyId?: string },
): Promise<void> {
  return runCommand(async () => {
    const token = await resolveToken({ ...opts, baseUrl: opts.tcpServer });
    const api = apiOptions(opts, token);

    // A company's own notices are listed only on its membership-checked route.
    const base = cmdOpts.companyId
      ? `/api/notifications/company/${encodeURIComponent(cmdOpts.companyId)}`
      : '/api/notifications';
    const path = cmdOpts.all ? `${base}?includeDismissed` : base;
    const notifications = await apiRequest<TcpNotification[]>(api, 'GET', path);
    process.stdout.write(JSON.stringify(notifications, null, 2) + '\n');
  });
}

/** Dismisses a notification for every user. stdout: the dismissed `TcpNotification`. */
export function dismissNotificationAction(
  opts: GlobalOptions,
  cmdOpts: { notificationId: string },
): Promise<void> {
  return runCommand(async () => {
    const token = await resolveToken({ ...opts, baseUrl: opts.tcpServer });
    const api = apiOptions(opts, token);

    const notification = await apiRequest<TcpNotification>(
      api,
      'POST',
      `/api/notifications/${encodeURIComponent(cmdOpts.notificationId)}/dismiss`,
    );
    process.stdout.write(JSON.stringify(notification, null, 2) + '\n');
  });
}

/**
 * Lifts a provider's spend cap (administrators only), until its next reset
 * or indefinitely. stdout: the updated `SpendCapState`.
 */
export function dismissCapAction(
  opts: GlobalOptions,
  cmdOpts: { provider: string; indefinitely?: boolean },
): Promise<void> {
  return runCommand(async () => {
    const token = await resolveToken({ ...opts, baseUrl: opts.tcpServer });
    const api = apiOptions(opts, token);

    const state = await apiRequest<SpendCapState>(
      api,
      'POST',
      `/api/spend/caps/${encodeURIComponent(cmdOpts.provider)}/dismiss`,
      { until: cmdOpts.indefinitely ? 'indefinite' : 'reset' },
    );
    process.stdout.write(JSON.stringify(state, null, 2) + '\n');
  });
}

/** Restores a dismissed spend cap (administrators only). stdout: the updated `SpendCapState`. */
export function restoreCapAction(
  opts: GlobalOptions,
  cmdOpts: { provider: string },
): Promise<void> {
  return runCommand(async () => {
    const token = await resolveToken({ ...opts, baseUrl: opts.tcpServer });
    const api = apiOptions(opts, token);

    const state = await apiRequest<SpendCapState>(
      api,
      'POST',
      `/api/spend/caps/${encodeURIComponent(cmdOpts.provider)}/restore`,
    );
    process.stdout.write(JSON.stringify(state, null, 2) + '\n');
  });
}

/**
 * Resumes a task's agents paused by a spend cap or a shutdown, exempting the
 * task from spend caps until it ends. stdout: `{ resumed }`.
 */
export function resumeTaskAction(
  opts: GlobalOptions,
  cmdOpts: { taskId: string },
): Promise<void> {
  return runCommand(async () => {
    const token = await resolveToken({ ...opts, baseUrl: opts.tcpServer });
    const api = apiOptions(opts, token);

    const result = await apiRequest<ResumeResult>(
      api,
      'POST',
      `/api/task/${encodeURIComponent(cmdOpts.taskId)}/resume`,
    );
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  });
}

/**
 * Resumes every paused task in a company, exempting them from spend caps
 * until they end — does not lift the cap for any other company. stdout:
 * `{ resumed }`.
 */
export function resumeCompanyAction(
  opts: GlobalOptions,
  cmdOpts: { companyId: string },
): Promise<void> {
  return runCommand(async () => {
    const token = await resolveToken({ ...opts, baseUrl: opts.tcpServer });
    const api = apiOptions(opts, token);

    const result = await apiRequest<ResumeResult>(
      api,
      'POST',
      `/api/company/${encodeURIComponent(cmdOpts.companyId)}/resume`,
    );
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  });
}
