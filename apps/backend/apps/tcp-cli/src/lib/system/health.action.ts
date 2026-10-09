import { apiOptions, GlobalOptions } from '../core/cli-options';
import { apiRequest } from '../core/api';
import { runCommand } from '../core/run-command';
import { resolveToken } from '../auth/token';

/** One service's health, as reported by `GET /api/system/health`. */
export interface ServiceHealth {
  name: string;
  status: 'up' | 'down' | 'not_configured';
  /** The service's own health document, when it sent one. */
  detail?: unknown;
  error?: string;
}

/** The combined health of every service. */
export interface SystemHealth {
  status: 'ok' | 'degraded';
  services: ServiceHealth[];
}

/**
 * Reports service health, or with `--app` just that one service. A degraded
 * system still exits 0: the command reports health, it doesn't judge it.
 *
 * stdout: the {@link SystemHealth}, or the one matching {@link ServiceHealth}.
 */
export function getHealthAction(
  opts: GlobalOptions,
  cmdOpts: { app?: string },
): Promise<void> {
  return runCommand(async () => {
    const token = await resolveToken({ ...opts, baseUrl: opts.tcpServer });
    const health = await apiRequest<SystemHealth>(
      apiOptions(opts, token),
      'GET',
      '/api/system/health',
    );

    let output: SystemHealth | ServiceHealth = health;
    const name = cmdOpts.app;
    if (name !== undefined) {
      const service = health.services.find((s) => s.name === name);
      if (!service) {
        const names = health.services.map((s) => s.name);
        throw new Error(`No service named ${name}. Known: ${names.join(', ')}`);
      }
      output = service;
    }
    process.stdout.write(JSON.stringify(output, null, 2) + '\n');
  });
}
