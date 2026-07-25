import { promptWithHelp } from '../utils/prompt-with-help';
import { DEFAULT_EXPOSE_PORT_API } from '../utils/app-defaults';
import {
  derivePorts,
  isValidPort,
  MINIO_CONSOLE_OFFSET,
  type DerivedPorts,
} from '../utils/ports';
import type { PortConfig } from '../types';

const PORT_ERROR = 'Must be a valid port number (1-65535)';
const portValidator = (input: number): true | string =>
  isValidPort(input) || PORT_ERROR;

/** Prompts for exposed port configuration. */
export async function promptPorts(): Promise<PortConfig> {
  const { apiPort } = await promptWithHelp<{ apiPort: number }>([
    {
      type: 'number',
      name: 'apiPort',
      message: 'API port (host-facing):',
      default: DEFAULT_EXPOSE_PORT_API,
      validate: portValidator,
      help: `The port the API server listens on from the host.
  - Other ports are derived from this using offsets (DB=API+2432, MinIO=API+6000, Zitadel=API+5080)
  - Default: ${DEFAULT_EXPOSE_PORT_API}
  - Change this to run multiple environments simultaneously`,
    },
  ]);

  const derived = derivePorts(apiPort);

  console.log(`\n  Derived ports (API + offset):`);
  console.log(`    DB:       ${derived.db}  (API + ${derived.db - apiPort})`);
  console.log(
    `    MinIO:    ${derived.minio}  (API + ${derived.minio - apiPort})`,
  );
  console.log(
    `    Zitadel:  ${derived.zitadel}  (API + ${derived.zitadel - apiPort})`,
  );
  console.log();

  const { override } = await promptWithHelp<{ override: boolean }>([
    {
      type: 'confirm',
      name: 'override',
      message: 'Override any of the derived ports?',
      default: false,
      help: `The derived ports are calculated from the API port using fixed offsets.
  Override only if you need specific ports (e.g. to avoid conflicts with other services).`,
    },
  ]);

  const ports = override ? await promptOverrides(derived) : derived;
  return {
    api: apiPort,
    db: ports.db,
    minio: ports.minio,
    minioConsole: ports.minio + MINIO_CONSOLE_OFFSET,
    zitadel: ports.zitadel,
  };
}

/** Prompts for explicit DB/MinIO/Zitadel ports, defaulting to the derived ones. */
function promptOverrides(derived: DerivedPorts): Promise<DerivedPorts> {
  return promptWithHelp<DerivedPorts>([
    {
      type: 'number',
      name: 'db',
      message: 'Postgres port:',
      default: derived.db,
      validate: portValidator,
    },
    {
      type: 'number',
      name: 'minio',
      message: 'MinIO API port:',
      default: derived.minio,
      validate: portValidator,
    },
    {
      type: 'number',
      name: 'zitadel',
      message: 'Zitadel port:',
      default: derived.zitadel,
      validate: portValidator,
    },
  ]);
}
