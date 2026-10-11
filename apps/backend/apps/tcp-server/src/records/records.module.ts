import { RecordsService } from '@tcp/shared';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule, getDataSourceToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

/** The TypeORM connection name for the records database. */
const RECORDS_CONNECTION = 'records';

/**
 * Gives tcp-server its own connection to the records database, so people can
 * read and correct records (001.03). That database is `RECORDS_DATABASE_URL`
 * when set, else tcp-server's own. tcp-mcp-records owns the tables and their
 * migrations; this connection only reads and writes rows, through the same
 * {@link RecordsService} the agents use.
 */
@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      name: RECORDS_CONNECTION,
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        // `||`, not `??`: compose passes an unset variable as ''.
        const url =
          config.get<string>('RECORDS_DATABASE_URL') ||
          config.get<string>('DATABASE_URL') ||
          '';
        // Unit tests boot without Postgres; records need it, so any call fails there.
        if (!url || url.startsWith('sqlite')) {
          return {
            name: RECORDS_CONNECTION,
            type: 'better-sqlite3',
            database: ':memory:',
          };
        }
        // `name` again here: the shutdown hook finds the connection by the
        // options this returns, and without it closes the default one.
        return {
          name: RECORDS_CONNECTION,
          type: 'postgres',
          url,
          extra: { max: 5 },
        };
      },
    }),
  ],
  providers: [
    {
      provide: RecordsService,
      useFactory: (ds: DataSource) => new RecordsService(ds),
      inject: [getDataSourceToken(RECORDS_CONNECTION)],
    },
  ],
  exports: [RecordsService],
})
export class RecordsModule {}
