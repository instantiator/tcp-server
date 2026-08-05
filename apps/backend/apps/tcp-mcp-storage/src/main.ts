import { bootstrapMcpApp } from '@tcp/shared';
import { AppModule } from './app.module';

/** Bootstraps the tcp-mcp-storage service and listens on {@link process.env.PORT} (default 3010). */
void bootstrapMcpApp({
  module: AppModule,
  title: 'TCP MCP Storage',
  description: 'MCP server exposing shared company document storage via MinIO',
  defaultPort: 3010,
});
