import type { LlmConfig } from '../models/LlmConfig.model';
import { findProvider } from './provider-catalogue';

/** Escapes `s` for literal use inside a `RegExp`. */
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Matches a remote template's `baseUrl`, with each `{region}` / `{resource}`
 * standing for exactly one DNS label, so a filled template can't reach a host
 * outside the provider's own domain.
 */
function templatePattern(baseUrl: string): RegExp {
  const parts = baseUrl.split(/\{(?:region|resource)\}/);
  return new RegExp(`^${parts.map(escapeRegExp).join('[a-z0-9-]+')}/?$`, 'i');
}

/**
 * Why `config` may not be used to reach an LLM, or `undefined` when it may.
 *
 * The server connects wherever `baseUrl` points, so an unchecked one lets a
 * caller make it reach internal services (SSRF). Remote providers may only use
 * their catalogue URL; local and custom ones only a host the operator listed.
 * There is deliberately no DNS or private-address check: it would refuse
 * every local model server, and DNS rebinding gets round it anyway.
 *
 * @param allowedHosts - lowercased hostnames a local or custom provider may use
 */
export function refuseBaseUrl(
  config: Pick<LlmConfig, 'provider' | 'baseUrl'>,
  allowedHosts: readonly string[],
): string | undefined {
  const template = findProvider(config.provider);
  if (!template) return `Unknown provider '${config.provider}'.`;
  if (!config.baseUrl) return undefined;

  let url: URL;
  try {
    url = new URL(config.baseUrl);
  } catch {
    return 'baseUrl is not a valid URL.';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return 'baseUrl must use http or https.';
  }
  if (url.username || url.password) {
    return 'baseUrl must not contain a username or password; use apiKey.';
  }

  if (template.kind === 'remote') {
    return templatePattern(template.baseUrl).test(config.baseUrl)
      ? undefined
      : `${template.name} must use its own URL: ${template.baseUrl}`;
  }
  return allowedHosts.includes(url.hostname.toLowerCase())
    ? undefined
    : `Host '${url.hostname}' is not allowed. Ask an operator to add it to LLM_ALLOWED_HOSTS.`;
}
