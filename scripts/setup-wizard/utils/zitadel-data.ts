import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '..', '..', '..');

/** The named volume holding the project's Postgres — Zitadel's data included. */
function postgresVolume(project: string): string {
  return `${project}_postgres_data`;
}

/**
 * Whether this Compose project already has a Postgres volume, and so a Zitadel
 * instance whose data is encrypted with some earlier master key. False when
 * Docker isn't installed or running, as on a brand new machine.
 */
export function hasZitadelData(project: string): boolean {
  const result = spawnSync(
    'docker',
    ['volume', 'inspect', postgresVolume(project)],
    { stdio: 'ignore' },
  );
  return result.status === 0;
}

/**
 * Stops the project's containers, deletes its Postgres volume and the
 * bootstrap PAT written by the Zitadel instance it held. The next start
 * bootstraps a fresh Zitadel with the current master key. Also wipes the app
 * database, which is recreated on the next start.
 */
export function resetZitadelData(project: string): void {
  // Run outside the repo so Compose finds containers by project label alone,
  // without reading docker-compose.yml and its env vars.
  run(['compose', '-p', project, 'down'], tmpdir());
  run(['volume', 'rm', postgresVolume(project)], tmpdir());
  rmSync(join(REPO_ROOT, 'docker', 'zitadel-machinekey', project, 'pat.txt'), {
    force: true,
  });
}

/** Runs a docker command, showing its output, and throws if it fails. */
function run(args: string[], cwd: string): void {
  const result = spawnSync('docker', args, { cwd, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `'docker ${args.join(' ')}' failed — see its output above.`,
    );
  }
}
