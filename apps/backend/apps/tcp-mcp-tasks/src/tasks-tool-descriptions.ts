import * as fs from 'fs';
import * as path from 'path';
import JSON5 from 'json5';

/** Tool names and descriptions for the tcp-mcp-tasks service. */
export interface TaskToolDescriptions {
  describe_server: string;
  create_plan: string;
  complete_assignment: string;
  assure_assignment: string;
}

/** Loaded once at module initialisation from the co-located {@link tools.jsonc} file. */
export const taskToolDescriptions: TaskToolDescriptions = JSON5.parse(
  fs.readFileSync(path.join(__dirname, 'tools.jsonc'), 'utf-8'),
);
