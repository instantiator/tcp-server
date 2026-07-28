/** Minimal shape needed to localize prompt date/time vars for a company. */
export interface WithTimezone {
  timezone?: string | null;
}

/** Date/time template variables available to `systemPromptTemplate` (`{{date}}`, `{{datetime}}`, `{{timezone}}`, `{{localDatetime}}`). */
export interface PromptDateVars {
  /** Bare UTC calendar date, `YYYY-MM-DD`. Kept for templates authored before `{{datetime}}` existed. */
  date: string;
  /** Explicit, human-labeled UTC timestamp — the LLM's authoritative "now". */
  datetime: string;
  /** The company's IANA timezone name, or `'UTC'` when none is set. */
  timezone: string;
  /** `datetime` re-rendered in the company's timezone; identical to `datetime` when no timezone is set. */
  localDatetime: string;
}

/**
 * Builds the date/time variables injected into every rendered
 * `systemPromptTemplate`. Storage and the LLM's authoritative time anchor
 * (`datetime`) are always UTC; `timezone`/`localDatetime` add company-local
 * context without ever replacing that anchor.
 *
 * Centralised here because the same construction was previously duplicated
 * verbatim in `tcp-agent`'s agent loop and `tcp-server`'s chat service.
 */
export function buildPromptDateVars(
  company: WithTimezone | null | undefined,
): PromptDateVars {
  const now = new Date();
  const date = now.toISOString().split('T')[0];
  const datetime = `${now.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
  const timezone = company?.timezone ?? 'UTC';

  let localDatetime = datetime;
  if (timezone !== 'UTC') {
    try {
      const formatted = new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      })
        .format(now)
        .replace(',', '');
      localDatetime = `${formatted} ${timezone}`;
    } catch {
      // Invalid/unknown IANA name — fall back to the UTC anchor rather than throwing.
      localDatetime = datetime;
    }
  }

  return { date, datetime, timezone, localDatetime };
}
