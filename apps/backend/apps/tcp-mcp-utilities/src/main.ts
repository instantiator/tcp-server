import { bootstrapMcpApp } from '@tcp/shared';
import { AppModule } from './app.module';

/** Bootstraps the tcp-mcp-utilities service and listens on {@link process.env.PORT} (default 3014). */
void bootstrapMcpApp({
  module: AppModule,
  title: 'TCP MCP Utilities',
  description:
    'MCP server for exact calculations: decimal arithmetic, date maths and unit conversion',
  defaultPort: 3014,
});
