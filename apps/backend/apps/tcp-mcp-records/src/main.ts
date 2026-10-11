import { bootstrapMcpApp } from '@tcp/shared';
import { AppModule } from './app.module';

/** Bootstraps the tcp-mcp-records service and listens on {@link process.env.PORT} (default 3015). */
void bootstrapMcpApp({
  module: AppModule,
  title: 'TCP MCP Records',
  description:
    'MCP server for typed, per-company record tables (orders, customers, stock) on Postgres JSONB',
  defaultPort: 3015,
});
