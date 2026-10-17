import {
  fillBaseUrl,
  findProvider,
  type LlmConfig,
  type ProviderTemplate,
  type SuggestedModel,
} from '@tcp/shared/client';
import { t } from '../../strings';

/** What a model is for: the agents' chat, or knowledge embeddings. */
export type LlmPurpose = 'chat' | 'embedding';

/** The provider choice that means "no config here: use the one it falls back to". */
export const INHERIT = '';

/**
 * A model config as the form holds it: every field as typed text.
 *
 * `apiKey` is only ever what the person typed. A saved key comes back from
 * the server masked, and is never put here, so it can't be sent back over the
 * real one.
 */
export interface LlmDraft {
  /** {@link INHERIT}, or a catalogue provider id. */
  readonly choice: string;
  readonly region: string;
  readonly resource: string;
  /** Only used for local and custom providers; remote ones build theirs. */
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKey: string;
  readonly contextWindow: string;
  readonly timeoutSeconds: string;
}

/** Field errors, already worded, keyed by field. */
export type LlmDraftErrors = Partial<Record<keyof LlmDraft, string>>;

/** Whether a provider's address is fixed by the provider (filled from a template). */
export const isRemote = (template: ProviderTemplate | undefined): boolean =>
  template?.kind === 'remote';

/** The `{region}` / `{resource}` values a filled template URL was built with. */
const placeholdersIn = (
  template: ProviderTemplate,
  url: string | undefined,
): { region?: string; resource?: string } => {
  if (!url) return {};
  const names: string[] = [];
  const pattern = template.baseUrl
    .replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
    .replace(/\\\{(region|resource)\\\}/g, (_, name: string) => {
      names.push(name);
      return '([^./]+)';
    });
  const match = new RegExp(`^${pattern}$`).exec(url);
  if (!match) return {};
  return Object.fromEntries(names.map((name, i) => [name, match[i + 1]]));
};

/** The form's starting state for a saved config, or for none. */
export const draftOf = (saved: LlmConfig | null | undefined): LlmDraft => {
  if (!saved) {
    return {
      choice: INHERIT,
      region: '',
      resource: '',
      baseUrl: '',
      model: '',
      apiKey: '',
      contextWindow: '',
      timeoutSeconds: '',
    };
  }
  const template = findProvider(saved.provider);
  const filled = template ? placeholdersIn(template, saved.baseUrl) : {};
  return {
    choice: saved.provider,
    region: filled.region ?? '',
    resource: filled.resource ?? '',
    baseUrl: saved.baseUrl ?? '',
    model: saved.model,
    apiKey: '',
    contextWindow:
      saved.contextWindow === undefined ? '' : String(saved.contextWindow),
    timeoutSeconds:
      saved.timeoutMs === undefined ? '' : String(saved.timeoutMs / 1000),
  };
};

/**
 * The draft after choosing `provider`: its address and starter model filled
 * in, but a model the person typed kept, since they meant it.
 */
export const chooseProvider = (
  draft: LlmDraft,
  provider: string,
  purpose: LlmPurpose,
): LlmDraft => {
  if (provider === INHERIT) return { ...draft, choice: INHERIT };
  const previous = findProvider(draft.choice);
  const template = findProvider(provider);
  const starterOf = (p: ProviderTemplate | undefined) =>
    purpose === 'chat' ? p?.chat?.starterModel : p?.embeddings?.starterModel;
  const typedModel =
    draft.model.trim() !== '' && draft.model !== starterOf(previous);
  const model = typedModel ? draft.model : (starterOf(template) ?? '');
  const suggested = template?.chat?.models.find((m) => m.id === model);
  return {
    ...draft,
    choice: provider,
    baseUrl: isRemote(template) ? '' : (template?.baseUrl ?? ''),
    model,
    contextWindow:
      purpose === 'chat' && suggested?.contextWindow !== undefined
        ? String(suggested.contextWindow)
        : draft.contextWindow,
  };
};

/**
 * The address the draft points at. A remote provider's comes from its
 * template; a local or custom one's is what was typed.
 */
export const baseUrlOf = (draft: LlmDraft): string => {
  const template = findProvider(draft.choice);
  if (template && isRemote(template)) {
    return fillBaseUrl(template, {
      region: draft.region.trim() || undefined,
      resource: draft.resource.trim() || undefined,
    });
  }
  return draft.baseUrl.trim();
};

/**
 * The address to send, or `undefined` to leave the saved one alone.
 *
 * A saved remote config with no address works (the OpenAI SDK fills hosted
 * OpenAI in), so re-saving it with the template's address would count as a
 * move and drop its key. When neither the provider nor its template's address
 * has changed, nothing is sent.
 */
const addressToSend = (
  draft: LlmDraft,
  saved: LlmConfig | null | undefined,
): string | undefined => {
  const url = baseUrlOf(draft);
  const template = findProvider(draft.choice);
  const unplacedTemplate =
    isRemote(template) && !/\{\w+\}/.test(template?.baseUrl ?? '');
  if (
    saved?.provider === draft.choice &&
    saved.baseUrl === undefined &&
    unplacedTemplate
  ) {
    return undefined;
  }
  return url || undefined;
};

/** Whether the draft points somewhere other than `saved` does. */
const moved = (draft: LlmDraft, saved: LlmConfig): boolean =>
  draft.choice !== saved.provider ||
  (addressToSend(draft, saved) ?? saved.baseUrl) !== saved.baseUrl;

/** The whole config the draft describes. Assumes {@link validate} passed. */
const configOf = (
  draft: LlmDraft,
  saved: LlmConfig | null | undefined,
): LlmConfig => {
  const baseUrl = addressToSend(draft, saved);
  const contextWindow = draft.contextWindow.trim();
  const timeout = draft.timeoutSeconds.trim();
  return {
    provider: draft.choice,
    model: draft.model.trim(),
    ...(baseUrl !== undefined && { baseUrl }),
    ...(contextWindow !== '' && { contextWindow: Number(contextWindow) }),
    ...(timeout !== '' && { timeoutMs: Math.round(Number(timeout) * 1000) }),
    ...(draft.apiKey !== '' && { apiKey: draft.apiKey }),
  };
};

/** Two configs that would run the same model the same way, keys aside. */
const sameSettings = (a: LlmConfig, b: LlmConfig): boolean =>
  a.provider === b.provider &&
  a.model === b.model &&
  (a.baseUrl ?? b.baseUrl) === b.baseUrl &&
  a.contextWindow === b.contextWindow &&
  a.timeoutMs === b.timeoutMs;

/**
 * What to send for this config: `undefined` when nothing changed, `null` to
 * clear it (so the fallback applies), or otherwise the **whole** config,
 * since the server refuses a partial one.
 *
 * `apiKey` is in it only when the person typed one.
 */
export const patchOf = (
  draft: LlmDraft,
  saved: LlmConfig | null | undefined,
): LlmConfig | null | undefined => {
  if (draft.choice === INHERIT) return saved ? null : undefined;
  const config = configOf(draft, saved);
  if (saved && draft.apiKey === '' && sameSettings(config, saved)) {
    return undefined;
  }
  return config;
};

/**
 * What will happen to a saved key on save. The server drops it when the
 * provider or address changes and no new key comes with the change, so the
 * form says so before it happens.
 */
export const keyState = (
  draft: LlmDraft,
  saved: LlmConfig | null | undefined,
): 'saved' | 'dropped' | 'none' => {
  if (!saved?.apiKey || draft.apiKey !== '' || draft.choice === INHERIT) {
    return 'none';
  }
  return moved(draft, saved) ? 'dropped' : 'saved';
};

/** The models to suggest: the catalogue's, then any more the server listed. */
export const suggestionsFor = (
  template: ProviderTemplate | undefined,
  purpose: LlmPurpose,
  listed: readonly string[] = [],
): SuggestedModel[] => {
  const curated: SuggestedModel[] =
    purpose === 'chat'
      ? [...(template?.chat?.models ?? [])]
      : template?.embeddings
        ? [
            {
              id: template.embeddings.starterModel,
              note: t('llm.model.width', {
                width: template.embeddings.dimension,
              }),
            },
          ]
        : [];
  const known = new Set(curated.map((m) => m.id));
  return [
    ...curated,
    ...listed.filter((id) => !known.has(id)).map((id) => ({ id })),
  ];
};

const isPositiveWhole = (text: string): boolean =>
  /^\d+$/.test(text) && Number(text) > 0;

const isHttpUrl = (text: string): boolean => {
  try {
    return ['http:', 'https:'].includes(new URL(text).protocol);
  } catch {
    return false;
  }
};

/**
 * What is wrong with the draft, field by field. Nothing is wrong with
 * inheriting.
 *
 * `dimension` is the width this deployment's vectors are stored at. An
 * embedding model known to make another width can't be indexed.
 */
export const validate = (
  draft: LlmDraft,
  purpose: LlmPurpose,
  dimension?: number,
): LlmDraftErrors => {
  if (draft.choice === INHERIT) return {};
  const template = findProvider(draft.choice);
  const errors: { -readonly [K in keyof LlmDraft]?: string } = {};
  if (draft.model.trim() === '') errors.model = t('llm.error.model');
  if (template?.fields.includes('region') && draft.region.trim() === '') {
    errors.region = t('llm.error.region');
  }
  if (template?.fields.includes('resource') && draft.resource.trim() === '') {
    errors.resource = t('llm.error.resource');
  }
  if (!isRemote(template) && !isHttpUrl(draft.baseUrl.trim())) {
    errors.baseUrl = t('llm.error.baseUrl');
  }
  const contextWindow = draft.contextWindow.trim();
  if (contextWindow !== '' && !isPositiveWhole(contextWindow)) {
    errors.contextWindow = t('llm.error.contextWindow');
  }
  const timeout = draft.timeoutSeconds.trim();
  if (timeout !== '' && !(Number(timeout) > 0)) {
    errors.timeoutSeconds = t('llm.error.timeout');
  }
  const known = template?.embeddings;
  if (
    purpose === 'embedding' &&
    dimension !== undefined &&
    known?.starterModel === draft.model.trim() &&
    known.dimension !== dimension
  ) {
    errors.model = t('llm.error.dimension', {
      width: known.dimension,
      dimension,
    });
  }
  return errors;
};
