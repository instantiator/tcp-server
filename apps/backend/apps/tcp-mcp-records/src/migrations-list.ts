import { RecordTables1784870000000 } from './migrations/1784870000000-RecordTables';
import { DataProtection1784910000000 } from './migrations/1784910000000-DataProtection';

/**
 * The records server's own migrations, run on its own connection into the
 * `records_migrations` table. Listed by hand, like tcp-server's: a glob
 * doesn't survive the webpack bundle.
 */
export const RECORDS_MIGRATIONS = [
  RecordTables1784870000000,
  DataProtection1784910000000,
];
