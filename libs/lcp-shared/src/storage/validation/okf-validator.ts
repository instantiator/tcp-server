import { load } from 'js-yaml';
import { ValidationResult } from './types';

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---/;

const MISSING_TITLE_HINT =
  "OKF documents require YAML front-matter with at least a 'title' field, e.g.:\n---\ntitle: My Document\n---";

/**
 * OKF documents are identified by *destination*, not extension — both plain
 * Markdown and OKF documents are `.md` files, but OKF is specifically the
 * knowledge-base layout `{company}/knowledge/{role}/*.md` (see
 * docs/glossary.md). Register this matcher ahead of the generic Markdown
 * matcher so it takes precedence (first-match-wins registry order).
 */
export function isOkfPath(path: string): boolean {
  return /\/knowledge\/[^/]+\/[^/]+\.md$/i.test(path);
}

/** Parses YAML front-matter from a Markdown document. Returns `null` when absent or unparsable. */
export function parseFrontMatter(
  content: string,
): Record<string, unknown> | null {
  const match = content.match(FRONT_MATTER);
  if (!match) return null;
  try {
    return (load(match[1]) as Record<string, unknown>) ?? {};
  } catch {
    return null;
  }
}

/** Validates that a document has OKF front-matter with a non-empty `title` field. */
export function validateOkf(content: string): ValidationResult {
  const frontMatter = parseFrontMatter(content);
  if (frontMatter === null) {
    return {
      valid: false,
      errors: [
        {
          message: 'Missing or unparsable YAML front-matter',
          llmHint: MISSING_TITLE_HINT,
        },
      ],
    };
  }
  const title = frontMatter['title'];
  if (!title || typeof title !== 'string' || !title.trim()) {
    return {
      valid: false,
      errors: [
        {
          message: "Front-matter is missing a non-empty 'title' field",
          llmHint: MISSING_TITLE_HINT,
        },
      ],
    };
  }
  return { valid: true, errors: [] };
}
