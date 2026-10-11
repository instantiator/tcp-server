import { PromptAssemblyStrings } from '@tcp/shared';

/**
 * Prompt part 8 — appended as the last message on the initial turn only.
 * Gives the agent a clear directive to begin work after all context has been
 * established by the preceding prompt parts.
 */
export const FINAL_INSTRUCTION =
  'You have been given your task and all relevant context above. Proceed now: be thorough, draw on your expertise, and deliver your best work.';

/**
 * Fixed strings for the shared prompt-part builders (see
 * {@link PromptAssemblyStrings}). tcp-server supplies its own set, mirroring
 * tcp-agent's jsonc-loaded `agentPrompts`, so chat and worker turns render the
 * same structure.
 */
export const CHAT_PROMPT_STRINGS: PromptAssemblyStrings = {
  services_header: '## Available Services',
  services_intro:
    "You have access to the following services through tools. Call any of their tools directly by its exact name; call a service's `describe_server` only if you want more detail.",
  services_item: '- **{{name}}**: use for {{usage}}',
  services_item_unknown:
    '- **{{name}}**: call `{{name}}__describe_server` for a full tool list and usage guide',
  rag_intro:
    'The following excerpts from your knowledge base are relevant to your current task. Draw on them as needed:',
  rag_source_header: '### Source: {{documentPath}}',
  assignment_materials_header:
    '## Materials (read each name below with `read_material_file`, or a `resource:` entry with `read_resource` — not a storage path)',
  assignment_expected_header:
    "## Expected outputs (each filename below is what you pass to `append_working_file`/`create_working_file` and to `complete_assignment`'s `prepared`; a `resource:` entry is a company resource you write with `write_resource` — not a storage path)",
};
