import { LlmConfig, refuseBaseUrl } from '@tcp/shared';
import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** The hostname of `url`, lowercased, or `undefined` when it isn't a URL. */
function hostOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * Decides where tcp-server may send LLM traffic: the operator's
 * `LLM_ALLOWED_HOSTS` plus the hosts of the application-level
 * `LLM_BASE_URL` / `EMBEDDING_BASE_URL`, which the operator already trusts.
 * See {@link refuseBaseUrl} for the rules.
 */
@Injectable()
export class LlmDestinationPolicy {
  readonly allowedHosts: readonly string[];

  constructor(config: ConfigService) {
    const listed = (config.get<string>('LLM_ALLOWED_HOSTS') ?? '')
      .split(',')
      .map((h) => h.trim().toLowerCase());
    this.allowedHosts = [
      ...listed,
      hostOf(config.get<string>('LLM_BASE_URL')),
      hostOf(config.get<string>('EMBEDDING_BASE_URL')),
    ].filter((h): h is string => !!h);
  }

  /** Why `config` may not be used, or `undefined` when it may. */
  refusal(config: Pick<LlmConfig, 'provider' | 'baseUrl'>): string | undefined {
    return refuseBaseUrl(config, this.allowedHosts);
  }

  /** Throws a 400 naming `field` when `config` is set and refused. */
  assertAllowed(
    config: Partial<Pick<LlmConfig, 'provider' | 'baseUrl'>> | null | undefined,
    field: 'llmConfig' | 'embeddingConfig',
  ): void {
    if (!config) return;
    const reason = config.provider
      ? this.refusal({ provider: config.provider, baseUrl: config.baseUrl })
      : 'provider is required.';
    if (reason) throw new BadRequestException(`${field}: ${reason}`);
  }
}

/**
 * Merges a partial `llmConfig` patch onto the stored one, so a patch of only
 * `model` keeps the rest. `null` removes the config.
 *
 * A patch that moves the config to another provider or address without
 * sending a key drops the stored key: otherwise the next call would hand the
 * old provider's key, as a bearer token, to whatever the new address is.
 */
export function mergeLlmConfig<T extends Partial<LlmConfig>>(
  existing: LlmConfig | null | undefined,
  patch: T | null | undefined,
): LlmConfig | T | null | undefined {
  if (patch === undefined) return existing;
  if (patch === null || existing == null) return patch;
  const moved =
    (patch.baseUrl !== undefined && patch.baseUrl !== existing.baseUrl) ||
    (patch.provider !== undefined && patch.provider !== existing.provider);
  const merged = { ...existing, ...patch };
  if (moved && !patch.apiKey) delete merged.apiKey;
  return merged;
}
