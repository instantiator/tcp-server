import { bootstrapMcpApp } from '@tcp/shared';
import { AppModule } from './app.module';

/** Bootstraps the tcp-mcp-memory service and listens on {@link process.env.PORT} (default 3011). */
void bootstrapMcpApp({
  module: AppModule,
  title: 'TCP MCP Memory',
  description:
    'MCP server for agent episodic memory retrieval and storage via pgvector',
  defaultPort: 3011,
});
