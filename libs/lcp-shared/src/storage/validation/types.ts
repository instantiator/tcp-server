/** A single validation problem found in a document. */
export interface ValidationError {
  /** Raw parser/schema error message. */
  message: string;
  /** JSON-pointer-style path into the document, when applicable. */
  path?: string;
  /** Plain-English remediation an LLM (or a human) can act on directly. */
  llmHint: string;
}

/** Result of validating a single document. */
export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

/** Context passed to a {@link DocumentValidator}. */
export interface ValidationContext {
  /** The document's storage key/path — used for OKF-vs-plain-Markdown dispatch and error messages. */
  path: string;
  /**
   * Resolves a local/relative schema reference (e.g. a `$schema` value) to its
   * raw text content, or `null` if not found. Never used to fetch remote URLs —
   * see docs/prompts/009.4 §Risks for why. Callers that can read from storage
   * (e.g. `StorageService`) should supply this; validators degrade to
   * structural-only checks when it's absent.
   */
  resolveRef?: (refPath: string) => Promise<string | null>;
}

/** A single format's validation logic. */
export type DocumentValidator = (
  content: string,
  context: ValidationContext,
) => ValidationResult | Promise<ValidationResult>;
