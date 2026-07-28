import { bootstrapMcpApp } from '@tcp/shared';
import { AppModule } from './app.module';

/** Bootstraps the tcp-mcp-interactions service and listens on {@link process.env.PORT} (default 3012). */
void bootstrapMcpApp({
  module: AppModule,
  title: 'TCP MCP Interactions',
  description:
    'MCP server for human-in-the-loop interactions, consultations, and task completion',
  defaultPort: 3012,
});
