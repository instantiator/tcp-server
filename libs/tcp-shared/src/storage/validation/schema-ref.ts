/**
 * Determines whether a `$schema` value is safe to resolve locally.
 *
 * Only relative/local paths are ever resolved (via a caller-supplied
 * `resolveRef`, against the same access-controlled storage namespace as the
 * document itself). Absolute `http(s)://` URLs are never fetched — see
 * docs/prompts/009.4 §Risks for the full threat model (SSRF, cloud
 * metadata endpoints, DoS, error-channel exfiltration). A document naming a
 * remote schema still gets full structural validation; it just isn't
 * checked against that schema.
 */
export function isLocalSchemaRef(ref: string): boolean {
  return !/^https?:\/\//i.test(ref);
}
