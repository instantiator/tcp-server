import * as fs from 'fs';
import * as path from 'path';
import JSON5 from 'json5';

/** Prompts and fixed strings for the lcp-mcp-interactions service. */
export interface InteractionPrompts {
  describe_server: string;
  paused_user_input: string;
  error_user_input: string;
  paused_consultation: string;
  error_consultation: string;
  error_list_users: string;
  error_list_roles: string;
}

/** Loaded once at module initialisation from the co-located {@link prompts.jsonc} file. */
export const interactionPrompts: InteractionPrompts = JSON5.parse(
  fs.readFileSync(path.join(__dirname, 'prompts.jsonc'), 'utf-8'),
);
