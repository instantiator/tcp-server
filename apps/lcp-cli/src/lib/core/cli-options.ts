import { Command } from 'commander';
import { ApiOptions } from './api';

/** Global options registered on the root program, available to every command. */
export interface GlobalOptions {
  lcpServer: string;
  accessToken?: string;
  refreshToken?: string;
  accessTokenEnvVar?: string;
}

/** Reads the global options off the root Commander program. */
export function getGlobalOptions(program: Command): GlobalOptions {
  return program.opts<GlobalOptions>();
}

/** Builds `ApiOptions` for a resolved token, against the global server URL. */
export function apiOptions(
  global: GlobalOptions,
  token: string,
  signal?: AbortSignal,
): ApiOptions {
  return { baseUrl: global.lcpServer, token, signal };
}
