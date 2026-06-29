import * as fs from 'fs';
import * as path from 'path';
import JSON5 from 'json5';

/** Tool names and descriptions for the lcp-mcp-interactions service. */
export interface InteractionToolDescriptions {
  describe_server: string;
  list_available_users: string;
  list_available_roles: string;
  request_user_input: string;
  request_agent_consultation: string;
  complete_task: string;
}

/** Loaded once at module initialisation from the co-located {@link tools.jsonc} file. */
export const interactionToolDescriptions: InteractionToolDescriptions =
  JSON5.parse(fs.readFileSync(path.join(__dirname, 'tools.jsonc'), 'utf-8'));
