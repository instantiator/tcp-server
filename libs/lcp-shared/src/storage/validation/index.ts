import { validateCsv } from './csv-validator';
import { validateJson } from './json-validator';
import { validateMarkdown } from './markdown-validator';
import { isOkfPath, validateOkf } from './okf-validator';
import { clearValidators, registerValidator } from './registry';
import { validateXml } from './xml-validator';
import { validateYaml } from './yaml-validator';

export * from './types';
export * from './registry';
export { validateJson } from './json-validator';
export { validateYaml } from './yaml-validator';
export { validateMarkdown } from './markdown-validator';
export { isOkfPath, parseFrontMatter, validateOkf } from './okf-validator';
export { validateXml } from './xml-validator';
export { validateCsv } from './csv-validator';
export { isLocalSchemaRef } from './schema-ref';

/**
 * Registers the default set of format validators against the shared
 * registry. Idempotent — safe to call multiple times (each call clears and
 * re-registers), which keeps test setup simple.
 *
 * Order matters: OKF's path-based matcher is registered ahead of the
 * generic Markdown matcher so OKF documents (`knowledge/{role_slug}/*.md`) get
 * the stricter front-matter check instead of the permissive plain-Markdown
 * fallback.
 */
export function registerDefaultValidators(): void {
  clearValidators();
  registerValidator(isOkfPath, validateOkf);
  registerValidator((path) => /\.md$/i.test(path), validateMarkdown);
  registerValidator((path) => /\.jsonc?$/i.test(path), validateJson);
  registerValidator((path) => /\.ya?ml$/i.test(path), validateYaml);
  registerValidator((path) => /\.xml$/i.test(path), validateXml);
  registerValidator((path) => /\.csv$/i.test(path), validateCsv);
}
