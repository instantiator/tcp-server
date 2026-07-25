import {
  DEFAULT_EXPOSE_PORT_API,
  DEFAULT_EXPOSE_PORT_DB,
  DEFAULT_EXPOSE_PORT_MINIO,
  DEFAULT_EXPOSE_PORT_ZITADEL,
} from './app-defaults';

/**
 * Offsets that derive each host port from `EXPOSE_PORT_API`, computed from the
 * shared defaults so they can never drift (DB=+2432, MinIO=+6000, Zitadel=+5080).
 */
const OFFSET = {
  db: DEFAULT_EXPOSE_PORT_DB - DEFAULT_EXPOSE_PORT_API,
  minio: DEFAULT_EXPOSE_PORT_MINIO - DEFAULT_EXPOSE_PORT_API,
  zitadel: DEFAULT_EXPOSE_PORT_ZITADEL - DEFAULT_EXPOSE_PORT_API,
} as const;

/** MinIO's console port sits one above its API port. */
export const MINIO_CONSOLE_OFFSET = 1;

/** The DB/MinIO/Zitadel host ports derived from the chosen API port. */
export interface DerivedPorts {
  db: number;
  minio: number;
  zitadel: number;
}

/** Derives the DB/MinIO/Zitadel host ports from the chosen API port. */
export function derivePorts(apiPort: number): DerivedPorts {
  return {
    db: apiPort + OFFSET.db,
    minio: apiPort + OFFSET.minio,
    zitadel: apiPort + OFFSET.zitadel,
  };
}

/** True for a valid TCP port number (1-65535). */
export function isValidPort(value: number): boolean {
  return Number.isInteger(value) && value > 0 && value < 65536;
}
