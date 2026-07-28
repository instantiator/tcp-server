import { bootstrapMcpApp } from '@tcp/shared';
import { AppModule } from './app.module';

/** Bootstraps the tcp-mcp-tasks service and listens on {@link process.env.PORT} (default 3013). */
void bootstrapMcpApp({
  module: AppModule,
  title: 'TCP MCP Tasks',
  description:
    'MCP server for task planning, assignment completion, and QA assurance',
  defaultPort: 3013,
});
