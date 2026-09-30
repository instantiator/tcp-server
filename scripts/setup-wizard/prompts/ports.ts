import { promptWithHelp } from '../utils/prompt-with-help';
import {
  DEFAULT_EXPOSE_PORT_AGENT,
  DEFAULT_EXPOSE_PORT_API,
  DEFAULT_EXPOSE_PORT_DB,
  DEFAULT_EXPOSE_PORT_MINIO,
  DEFAULT_EXPOSE_PORT_MINIO_CONSOLE,
  DEFAULT_EXPOSE_PORT_WEB,
  DEFAULT_EXPOSE_PORT_ZITADEL,
} from '../utils/app-defaults';
import { isValidPort } from '../utils/ports';
import type { PortConfig } from '../types';

const PORT_ERROR = 'Must be a valid port number (1-65535)';
const portValidator = (input: number): true | string =>
  isValidPort(input) || PORT_ERROR;

/** Each port's default, in the order they're shown and asked. */
const DEFAULTS: PortConfig = {
  api: DEFAULT_EXPOSE_PORT_API,
  db: DEFAULT_EXPOSE_PORT_DB,
  minio: DEFAULT_EXPOSE_PORT_MINIO,
  minioConsole: DEFAULT_EXPOSE_PORT_MINIO_CONSOLE,
  web: DEFAULT_EXPOSE_PORT_WEB,
  agent: DEFAULT_EXPOSE_PORT_AGENT,
};

const LABELS: Record<keyof PortConfig, string> = {
  api: 'API',
  db: 'Postgres',
  minio: 'MinIO API',
  minioConsole: 'MinIO console',
  web: 'Web client (HTTPS)',
  agent: 'tcp-agent (dev ports)',
};

/**
 * Shows the host ports the stack will use, each with its own default, and
 * lets the user change any of them. The bundled Zitadel's port is fixed.
 */
export async function promptPorts(): Promise<PortConfig> {
  console.log('\nHost ports (each has its own default):');
  for (const key of Object.keys(DEFAULTS) as (keyof PortConfig)[]) {
    console.log(`    ${LABELS[key].padEnd(22)} ${DEFAULTS[key]}`);
  }
  console.log(
    `    ${'Zitadel (bundled)'.padEnd(22)} ${DEFAULT_EXPOSE_PORT_ZITADEL}  (fixed)`,
  );
  console.log();

  const { change } = await promptWithHelp<{ change: boolean }>([
    {
      type: 'confirm',
      name: 'change',
      message: 'Change any of these ports?',
      default: false,
      help: `Change them only if something else already uses one — for example another
TCP stack. All the ports you end up with are written to the env file.
The bundled Zitadel always uses port ${DEFAULT_EXPOSE_PORT_ZITADEL}: its bootstrap and its sign-in
URLs assume it, so two stacks with the bundled Zitadel can't run at once.
Stop the other one first (./scripts/stop-dev.sh --project <name>).`,
    },
  ]);
  if (!change) return { ...DEFAULTS };

  return promptWithHelp<PortConfig>(
    (Object.keys(DEFAULTS) as (keyof PortConfig)[]).map((key) => ({
      type: 'number' as const,
      name: key,
      message: `${LABELS[key]} port:`,
      default: DEFAULTS[key],
      validate: portValidator,
    })),
  );
}
