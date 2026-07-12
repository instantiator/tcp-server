import * as fs from 'fs';
import * as path from 'path';
import JSON5 from 'json5';

/** Prompts and fixed strings for the lcp-mcp-tasks service. */
export interface TaskPrompts {
  describe_header: string;
  current_mode: string;
  plan_created: string;
  assignment_completed: string;
  assignment_assured: string;
  error_wrong_mode: string;
  error_no_assignment: string;
  error_create_plan: string;
  error_complete_assignment: string;
  error_assure_assignment: string;
}

/** Loaded once at module initialisation from the co-located {@link prompts.jsonc} file. */
export const taskPrompts: TaskPrompts = JSON5.parse(
  fs.readFileSync(path.join(__dirname, 'prompts.jsonc'), 'utf-8'),
);
