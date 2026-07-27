import { PrecedenceResolver } from './precedence-resolver';

/** Minimal shape needed to resolve a system prompt template. */
export interface WithSystemPromptTemplate {
  systemPromptTemplate?: string | null;
}

/**
 * Resolves the `systemPromptTemplate` to render for an agent's system
 * message, in the standard precedence order: role → company → baked-in
 * default (see `DEFAULT_SYSTEM_PROMPT_TEMPLATE`).
 *
 * A blank (empty or whitespace-only) template counts as "not set", same as
 * null/undefined — the field should always resolve to real content, so a
 * blank role template falls through to the company's, and a blank company
 * template falls through to the default, rather than rendering an empty
 * system message.
 *
 * @param role - The role for the current agent run (may be null).
 * @param company - The company for the current agent run (may be null).
 * @param defaultTemplate - The baked-in fallback template; always defined.
 */
export class SystemPromptTemplateResolver extends PrecedenceResolver<string> {
  constructor(
    private readonly role: WithSystemPromptTemplate | null | undefined,
    private readonly company: WithSystemPromptTemplate | null | undefined,
    private readonly defaultTemplate: string,
  ) {
    super();
  }

  protected getSources(): Array<string | null | undefined> {
    return [
      this.role?.systemPromptTemplate,
      this.company?.systemPromptTemplate,
    ].map((template) => (template?.trim() ? template : null));
  }

  protected getDefault(): string {
    return this.defaultTemplate;
  }
}

/** Convenience wrapper: `new SystemPromptTemplateResolver(role, company, defaultTemplate).resolve()`. */
export function resolveSystemPromptTemplate(
  role: WithSystemPromptTemplate | null | undefined,
  company: WithSystemPromptTemplate | null | undefined,
  defaultTemplate: string,
): string {
  // Non-null: getDefault() always returns a defined string, so resolve() can't return undefined here.
  return new SystemPromptTemplateResolver(
    role,
    company,
    defaultTemplate,
  ).resolve()!;
}
