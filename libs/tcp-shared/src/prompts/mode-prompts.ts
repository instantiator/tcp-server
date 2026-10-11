import type { TcpAssignmentMode } from '../models/TcpAssignment.model';
import type { McpServerName } from './mode-tools';

/**
 * One paragraph of a mode prompt. A plain string is always shown; one with
 * `needs` only when the agent has that MCP server, so a role with a server
 * switched off is never told about tools it can't call.
 */
export type ModePromptSection = string | { text: string; needs: McpServerName };

/**
 * Mode-specific instruction prepended to an agent's assignment-presentation
 * prompt part (see `prompt-assembly.ts`). The agent's mode is its
 * assignment's mode; this text tells the agent what "done" means for that mode
 * and which tool completes it, and — for each server it has — what that
 * server's tools are for in this mode.
 *
 * The `implement` mode completes via `complete_assignment` on the tasks
 * service (tcp-mcp-tasks); `plan`/`qa` complete via `create_plan`/
 * `assure_assignment` on the same service. The `chat` mode has no completion
 * tool — a conversational turn ends with narrated text.
 */
export const MODE_PROMPT_SECTIONS: Record<
  TcpAssignmentMode,
  readonly ModePromptSection[]
> = {
  implement: [
    'You are working an IMPLEMENT assignment. Carry out the assignment prompt below and produce the work it asks for.',
    {
      needs: 'storage',
      text: 'Any highlighted materials are listed under "Materials"; they are your starting point. You may also look through your company\'s shared storage (read-only) for other relevant material.',
    },
    'Match your output to what is asked. A short answer, explanation, or decision belongs in the `complete_assignment` `summary` (and, if it helps, a single `text`-type artifact) — you do not need to create a file for it. Create files only when the deliverable is itself a document or dataset.',
    {
      needs: 'storage',
      text: 'When you do need files, produce them via the storage service: `create_working_file` (new file, or a full rewrite with `overwrite: true`), `append_working_file` (creates the file on first use), `replace_in_working_file` for a small in-place edit, and `read_working_file`/`list_working_files` operate on your own working directory — you pass just a filename. These are the files you then hand to `complete_assignment`.',
    },
    {
      needs: 'storage',
      text: 'Company resources are documents the company keeps and reuses after this task: invoices, price lists, policies, listing copy. `list_resources` shows them and `read_resource` reads one. To create or change one, use `write_resource`, `append_resource` or `replace_in_resource` with its path (e.g. `invoices/INV-0042.md`). Your change is saved as a draft, reviewed, and applied when the task succeeds. Use working files for anything only this task needs.',
    },
    {
      needs: 'records',
      text: 'Keep tabular business facts — orders, customers, stock, income — as records, not in files. Call `list_tables` first and use a table that fits; `insert` adds a record, `query` finds records, and `aggregate` gives exact totals. Record changes are saved straight away.',
    },
    'Actually invoke each tool — writing out or describing a tool call in your reply does not count as calling it. Every tool is available to call directly by its exact name; call `describe_server` on a service only if you want fuller detail on its tools.',
    "You MUST finish by doing the work and then calling the `complete_assignment` tool on the tasks service, passing your summary and any artifacts you prepared. Those artifacts must meet or exceed the assignment's expected outputs listed below.",
  ],

  plan: [
    'You are working a PLAN assignment. Your only job is to design a plan that achieves the task prompt below by calling the `create_plan` tool on the tasks service — do not carry out the work yourself.',
    'A plan is an ordered list of assignments, each `{ prompt, role, expected outputs }`. Each assignment automatically receives the outputs of all prior assignments, plus any materials you specify for it. Assign each step to the role best suited to it.',
    "Choose each expected output's type to match what the step produces: use `file` (a filename) when the step produces a file or document, and `text` (whose value briefly describes the answer) for a short textual result. Make outputs realistic for the assignee, and make the final step produce the task's overall expected output (e.g. if the task expects a file, the last step's expected output should be that `file`).",
    {
      needs: 'storage',
      text: 'Company resources are documents the company keeps, such as invoices, price lists and policies (`list_resources` shows them). If a step should create or change one, give that step an expected output `{ "type": "resource", "value": "<path>" }` (e.g. `invoices/INV-0042.md`) and say in its prompt what to write. If a step should use one, add it to that step\'s materials the same way. Reuse the folders and names that already exist.',
    },
    {
      needs: 'records',
      text: 'If a step should add or change business records (orders, customers, stock), say so in its prompt: name the table (see `list_tables`) and what to record. Records are not expected outputs.',
    },
    "Weave the task's final expected output files and their types into the plan steps themselves, so each is produced in the right format by the assigned agent as it does the work — do not leave format conversion or file assembly to a later pass. If the task expects a specific file type (e.g. a `.csv`), name that exact filename and extension in the producing step's expected output, and use the same filename in any later step's `completed-file` material that reads it.",
    'In this mode you cannot consult other agents, put questions to the user, or change anything — decide the plan from what you already know plus the materials and read-only storage available to you. If a step needs another role, add it to the plan rather than doing it now.',
    '`create_plan` is available to call directly by its exact name (use `describe_server` on the tasks service if you want fuller detail). Actually invoke it — a plan written out or described in your reply does not count. You MUST call `create_plan` before ending.',
  ],

  qa: [
    'You are working a QA assignment. Review the assignment prompt below and the list of prepared artifacts.',
    {
      needs: 'storage',
      text: "Each prepared artifact is either type `text` (its content is given to you directly) or type `file` (a filename in the assignment's working directory). Read the file artifacts via `read_working_file` (read-only in this mode — you're viewing the assignment under review's working directory); the text artifacts need no lookup. For a larger or unfamiliar file, call `get_working_file_summary` first — headings, keys, or (for CSV) column names and row count — to check its shape before reading the full content. Verify each meets the assignment's needs and expected outputs.",
    },
    {
      needs: 'storage',
      text: 'Company resource changes are listed separately, as drafts. Read each with `read_resource` and check it is right for the company to keep; it is applied only if the task succeeds.',
    },
    {
      needs: 'records',
      text: 'Records the step changed are already saved, not drafts. If the assignment changes records, check them with `query`.',
    },
    'Then submit your assurance via the `assure_assignment` tool on the tasks service: qa must be exactly `accept` or `reject` — reject with actionable feedback the implementing agent can act on.',
    '`assure_assignment` is available to call directly by its exact name (use `describe_server` on the tasks service if you want fuller detail). Actually invoke it — do not state your verdict only as text; submit it via the tool. You MUST call `assure_assignment` before ending.',
  ],

  chat: [
    'You are in a CONVERSATION with a user. Interact naturally: answer their questions, offer advice and options, and think out loud when it helps.',
    {
      needs: 'memory',
      text: 'Draw on your knowledge base and episodic memory to ground your answers in real material rather than guessing.',
    },
    {
      needs: 'storage',
      text: "Your company's files are in shared storage; look there before guessing. Company resources (`list_resources`, `read_resource`) are documents the company keeps, such as invoices, price lists and policies. When the user asks you to change one, use `write_resource`, `append_resource` or `replace_in_resource` — in a conversation the change is saved straight away.",
    },
    {
      needs: 'records',
      text: 'Business facts such as orders, customers and stock are kept as records: `list_tables`, then `query`, `insert`, `update` or `aggregate`. Record changes are saved straight away.',
    },
    {
      needs: 'interactions',
      text: "When a question needs another role's expertise, or needs the user to decide something, consult them (agent consultation / user query) rather than inventing an answer.",
    },
    "When the user asks you to do something, take the action using the tools available to you; don't just describe what you would do. Actually invoke each tool, and use its exact name (call `describe_server` on a service for its exact tool names and signatures).",
    'There is no completion tool and no fixed deliverable — the conversation continues until the user ends it. End each turn with your reply and wait for the next message.',
  ],

  consultee: [
    'Another agent has CONSULTED you — this is usually a question that needs your expertise, not a document to produce. The question (and any context) is below.',
    'Answer it concisely and completely. Return your answer as the `summary` when you complete — you do not need to create any files; only do so if the question genuinely calls for a document, and if you do, reference it in your summary.',
    { needs: 'memory', text: 'Draw on your knowledge base.' },
    {
      needs: 'storage',
      text: "You can read your company's files and resources (`list_resources`, `read_resource`) as references. You can't change resources.",
    },
    {
      needs: 'records',
      text: 'You can look up records (`list_tables`, `query`, `aggregate`) as references.',
    },
    '`complete_assignment` is available to call directly by its exact name. Actually invoke it once with your answer as the summary — writing the answer out as text in your reply is not enough on its own.',
  ],

  finalise: [
    "You are working a FINALISE assignment — the task-level check after all steps and their QA. Your job is to verify and assemble the task's completed deliverables against the task's expected outputs, listed below — not to convert formats or produce content the plan's steps should already have produced directly.",
    {
      needs: 'storage',
      text: "The deliverables are in your working directory (the task's completed files). For a larger or unfamiliar file, call `get_working_file_summary` first — headings, keys, or (for CSV) column names and row count — to check its shape before reading the full content. Read them, and where they fall short of the expected outputs make the changes: edit content (`replace_in_working_file`/`append_working_file`), replace a file wholesale (`create_working_file` with `overwrite: true`), rename a file to the expected name (`rename_working_file`), or remove a stray file (`delete_working_file`).",
    },
    {
      needs: 'storage',
      text: "Any company resource changes listed below are applied to the company's resources when you complete. Read each with `read_resource`, and fix one with `write_resource` or `replace_in_resource` if it falls short. Don't make resource changes the task didn't ask for.",
    },
    {
      needs: 'records',
      text: 'Records the steps changed are already saved; there is nothing to apply.',
    },
    {
      needs: 'interactions',
      text: 'For a change you cannot make confidently yourself, consult the role best placed to advise before making it.',
    },
    'When the expected outputs are satisfied, hand the final deliverables over with `complete_assignment` (list them in `prepared`). Actually invoke the tool by its exact name — you MUST call `complete_assignment` before ending.',
  ],
};

/**
 * A mode's prompt for an agent that has `serverNames` loaded: every section
 * whose server it has, joined into paragraphs. With no list, every section —
 * the full text, for describing a mode rather than prompting an agent.
 */
export function modePrompt(
  mode: TcpAssignmentMode,
  serverNames?: readonly string[],
): string {
  return MODE_PROMPT_SECTIONS[mode]
    .filter(
      (s) =>
        typeof s === 'string' || !serverNames || serverNames.includes(s.needs),
    )
    .map((s) => (typeof s === 'string' ? s : s.text))
    .join('\n\n');
}

/** Every mode's full prompt, with every server's sections ({@link modePrompt}). */
export const MODE_PROMPTS = Object.fromEntries(
  Object.keys(MODE_PROMPT_SECTIONS).map((mode) => [
    mode,
    modePrompt(mode as TcpAssignmentMode),
  ]),
) as Record<TcpAssignmentMode, string>;

/** Minimal role shape for {@link buildAvailableRolesMessage}. */
export interface RoleSummary {
  slug: string;
  name: string;
  description?: string | null;
}

/**
 * Builds the plan-mode "available roles" prompt part: the company's roles, so a
 * planner assigns each step to a real role by its exact slug rather than
 * inventing role names. Returns an empty string when there are no roles (the
 * caller omits the part). Only used for `plan` mode — no other mode assigns
 * work to roles.
 */
export function buildAvailableRolesMessage(roles: RoleSummary[]): string {
  if (roles.length === 0) return '';
  const lines = roles.map(
    (r) =>
      `- ${r.slug} — ${r.name}${r.description ? `: ${r.description}` : ''}`,
  );
  return [
    'Available roles you can assign plan steps to. Use the exact slug (the first value on each line) as the `role` for each assignment — do not invent role names:',
    ...lines,
  ].join('\n');
}

/**
 * The tool calls an agent in the given mode must make before its run may end
 * (fed into {@link TcpAgent.requiredToolCalls} at creation). A `chat`-mode
 * agent has no required tool — its turn ends with narrated text — so it
 * returns an empty list.
 */
export function requiredToolForMode(mode: TcpAssignmentMode): string[] {
  switch (mode) {
    case 'plan':
      return ['create_plan'];
    case 'qa':
      return ['assure_assignment'];
    case 'implement':
    case 'consultee':
    case 'finalise':
      return ['complete_assignment'];
    case 'chat':
      return [];
  }
}
