import {
  PROVIDER_CATALOGUE,
  RECOMMENDED_LOCAL_CONTEXT_WINDOW,
  findProvider,
  type LlmConfig,
  type ProviderTemplate,
} from '@tcp/shared/client';
import { RefreshCw } from 'lucide-react';
import { useState } from 'react';
import {
  Button,
  ComboBox,
  FieldError,
  Header,
  Input,
  Label,
  ListBox,
  ListBoxItem,
  ListBoxSection,
  Popover,
  Select,
  SelectValue,
  Text,
  type Key,
} from 'react-aria-components';
import { ApiError } from '../../api/errors';
import { useLocalModels, type LocalModelsQuery } from '../../api/hooks';
import { t } from '../../strings';
import { TextField } from '../Field/TextField';
import { RoundIconButton } from '../RoundIconButton/RoundIconButton';
import './LlmConfigPicker.css';
import {
  INHERIT,
  baseUrlOf,
  chooseProvider,
  isRemote,
  keyState,
  suggestionsFor,
  type LlmDraft,
  type LlmDraftErrors,
  type LlmPurpose,
} from './llmDraft';

/** What an inherit choice falls back to, and from where. */
export interface LlmFallback {
  readonly from: 'company' | 'app';
  readonly config: Pick<LlmConfig, 'provider' | 'model'> | null;
}

export interface LlmConfigPickerProps {
  readonly purpose: LlmPurpose;
  readonly draft: LlmDraft;
  readonly onChange: (draft: LlmDraft) => void;
  /** The saved config, as the server returned it (key masked). */
  readonly saved: LlmConfig | null | undefined;
  readonly fallback: LlmFallback;
  /**
   * The company whose saved keys a local server's model list may use. Absent
   * while the company is being created or imported: the list then uses only a
   * typed key.
   */
  readonly companyId?: string;
  /** A role whose saved key may be used to list a local server's models. */
  readonly roleId?: string;
  /** Tokens the role's tools take a turn, or `unsaved` for a new role. */
  readonly footprint?: number | 'unsaved';
  /** The width this deployment's vectors are stored at. */
  readonly embeddingDimension?: number;
  readonly errors: LlmDraftErrors;
}

/** The Select's key for the inherit choice; React Aria keys can't be empty. */
const INHERIT_KEY = 'inherit';

const GROUPS = [
  { kind: 'remote', label: 'llm.provider.remote' },
  { kind: 'local', label: 'llm.provider.local' },
  { kind: 'custom', label: 'llm.provider.custom' },
] as const;

const providerName = (id: string): string => findProvider(id)?.name ?? id;

/** The listing request for a local or custom draft with a usable address. */
const listingOf = (
  draft: LlmDraft,
  roleId: string | undefined,
): LocalModelsQuery | null => {
  const template = findProvider(draft.choice);
  const baseUrl = baseUrlOf(draft);
  if (!template || isRemote(template) || !/^https?:\/\/./.test(baseUrl)) {
    return null;
  }
  return {
    provider: draft.choice,
    baseUrl,
    ...(draft.apiKey !== '' && { apiKey: draft.apiKey }),
    ...(roleId !== undefined && { roleId }),
  };
};

/** The context window hint: what the field is, then advice for this draft. */
const contextHint = (
  draft: LlmDraft,
  template: ProviderTemplate | undefined,
  footprint: number | 'unsaved' | undefined,
): string => {
  const parts = [t('llm.contextWindow.hint')];
  const window = Number(draft.contextWindow);
  if (
    template?.kind === 'local' &&
    !(window >= RECOMMENDED_LOCAL_CONTEXT_WINDOW)
  ) {
    parts.push(
      t('llm.contextWindow.local', {
        recommended: RECOMMENDED_LOCAL_CONTEXT_WINDOW.toLocaleString(),
      }),
    );
  }
  if (footprint === 'unsaved') {
    parts.push(t('llm.contextWindow.unsaved'));
  } else if (footprint !== undefined && window > 0) {
    parts.push(
      window > footprint
        ? t('llm.contextWindow.budget', {
            tools: footprint.toLocaleString(),
            left: (window - footprint).toLocaleString(),
          })
        : t('llm.contextWindow.tooSmall', {
            tools: footprint.toLocaleString(),
          }),
    );
  }
  return parts.join(' ');
};

/**
 * Chooses a language model: inherit the fallback, or a catalogue provider
 * with its address, model, key and limits. Used for a role's model and a
 * company's chat and embedding models.
 *
 * A form section, not a form: the host owns the draft and saves it with
 * {@link patchOf}, so a role's details and model save in one action. The API
 * key field only ever holds what is typed; a saved key is described, never
 * shown or sent back.
 */
export const LlmConfigPicker = ({
  purpose,
  draft,
  onChange,
  saved,
  fallback,
  companyId,
  roleId,
  footprint,
  embeddingDimension,
  errors,
}: LlmConfigPickerProps) => {
  const template = findProvider(draft.choice);
  // Listing follows the provider as chosen, and asks again on "Refresh",
  // rather than on every keystroke in the address or key fields.
  const [listing, setListing] = useState(() => listingOf(draft, roleId));
  const [revision, setRevision] = useState(0);
  const models = useLocalModels(companyId, listing, revision);

  const choose = (key: Key | null): void => {
    const next = chooseProvider(
      draft,
      key === INHERIT_KEY || key === null ? INHERIT : String(key),
      purpose,
    );
    setListing(listingOf(next, roleId));
    onChange(next);
  };

  const refresh = (): void => {
    setListing(listingOf(draft, roleId));
    setRevision((r) => r + 1);
  };

  const inheritLabel = fallback.config
    ? t(
        fallback.from === 'company' ? 'llm.inherit.company' : 'llm.inherit.app',
        {
          provider: providerName(fallback.config.provider),
          model: fallback.config.model,
        },
      )
    : t('llm.inherit.none');

  const offered = PROVIDER_CATALOGUE.filter(
    (p) => purpose === 'chat' || p.embeddings || p.kind === 'custom',
  );
  const suggestions = suggestionsFor(template, purpose, models.data?.models);
  const keyHint = {
    saved: t('llm.apiKey.saved'),
    dropped: t('llm.apiKey.dropped'),
    none: template?.kind === 'local' ? t('llm.apiKey.local') : undefined,
  }[keyState(draft, saved)];
  const listError =
    models.error instanceof ApiError
      ? models.error.message
      : models.error
        ? t('records.error.generic')
        : undefined;

  return (
    <div className="tcp-llm-picker">
      <Select
        className="react-aria-Select tcp-field"
        value={draft.choice === INHERIT ? INHERIT_KEY : draft.choice}
        onChange={choose}
      >
        <Label className="react-aria-Label tcp-field__label">
          {t('llm.provider')}
        </Label>
        <Button className="react-aria-Button tcp-llm-picker__select">
          <SelectValue />
        </Button>
        <Popover>
          <ListBox>
            <ListBoxItem id={INHERIT_KEY} textValue={inheritLabel}>
              {inheritLabel}
            </ListBoxItem>
            {GROUPS.map(({ kind, label }) => (
              <ListBoxSection key={kind}>
                <Header className="react-aria-Header">{t(label)}</Header>
                {offered
                  .filter((p) => p.kind === kind)
                  .map((p) => (
                    <ListBoxItem key={p.id} id={p.id} textValue={p.name}>
                      {p.name}
                    </ListBoxItem>
                  ))}
              </ListBoxSection>
            ))}
          </ListBox>
        </Popover>
      </Select>

      {draft.choice === INHERIT ? (
        fallback.config === null && (
          <p className="tcp-field__hint">{t('llm.inherit.noneHint')}</p>
        )
      ) : (
        <>
          {template?.notes !== undefined && (
            <p className="tcp-field__hint">{template.notes}</p>
          )}
          {template?.fields.includes('region') && (
            <TextField
              label={t('llm.region')}
              value={draft.region}
              onChange={(region) => onChange({ ...draft, region })}
              description={t('llm.region.hint')}
              errorMessage={errors.region}
              isRequired
            />
          )}
          {template?.fields.includes('resource') && (
            <TextField
              label={t('llm.resource')}
              value={draft.resource}
              onChange={(resource) => onChange({ ...draft, resource })}
              description={t('llm.resource.hint')}
              errorMessage={errors.resource}
              isRequired
            />
          )}
          {isRemote(template) ? (
            <p className="tcp-field__hint">
              {t('llm.baseUrl.fixed', { url: baseUrlOf(draft) })}
            </p>
          ) : (
            <TextField
              label={t('llm.baseUrl')}
              value={draft.baseUrl}
              onChange={(baseUrl) => onChange({ ...draft, baseUrl })}
              description={t('llm.baseUrl.hint')}
              errorMessage={errors.baseUrl}
              isRequired
            />
          )}

          <div className="tcp-llm-picker__model">
            <ComboBox
              className="react-aria-ComboBox tcp-field"
              allowsCustomValue
              menuTrigger="focus"
              inputValue={draft.model}
              onInputChange={(model) => onChange({ ...draft, model })}
              isRequired
              isInvalid={errors.model !== undefined}
              validationBehavior="aria"
            >
              <Label className="react-aria-Label tcp-field__label">
                {t('llm.model')}
              </Label>
              <Input className="react-aria-Input" />
              <Text
                slot="description"
                className="react-aria-Text tcp-field__hint"
              >
                {listError !== undefined
                  ? t('llm.model.listFailed', { reason: listError })
                  : t('llm.model.hint')}
              </Text>
              {errors.model !== undefined && (
                <FieldError className="react-aria-FieldError tcp-field__error">
                  {errors.model}
                </FieldError>
              )}
              <Popover>
                <ListBox items={suggestions}>
                  {(m) => (
                    <ListBoxItem id={m.id} textValue={m.id}>
                      <Text slot="label">{m.id}</Text>
                      {m.note !== undefined && (
                        <Text slot="description" className="tcp-field__hint">
                          {m.note}
                        </Text>
                      )}
                    </ListBoxItem>
                  )}
                </ListBox>
              </Popover>
            </ComboBox>
            {!isRemote(template) && (
              <RoundIconButton
                icon={RefreshCw}
                label={t('llm.model.refresh')}
                onPress={refresh}
                isDisabled={listingOf(draft, roleId) === null}
                isPending={models.isFetching}
              />
            )}
          </div>

          {template?.fields.includes('apiKey') && (
            <>
              <TextField
                label={t('llm.apiKey')}
                type="password"
                value={draft.apiKey}
                onChange={(apiKey) => onChange({ ...draft, apiKey })}
                description={keyHint}
              />
              {template.keysPageUrl !== undefined && (
                <p className="tcp-field__hint">
                  <a
                    href={template.keysPageUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {t('llm.apiKey.getOne')}
                    <span className="visually-hidden">
                      {' '}
                      {t('llm.apiKey.newTab')}
                    </span>
                  </a>
                </p>
              )}
            </>
          )}

          {purpose === 'chat' ? (
            <TextField
              label={t('llm.contextWindow')}
              value={draft.contextWindow}
              onChange={(contextWindow) =>
                onChange({ ...draft, contextWindow })
              }
              description={contextHint(draft, template, footprint)}
              errorMessage={errors.contextWindow}
            />
          ) : (
            embeddingDimension !== undefined && (
              <p className="tcp-field__hint">
                {t('llm.embedding.width', { dimension: embeddingDimension })}
              </p>
            )
          )}
          <TextField
            label={t('llm.timeout')}
            value={draft.timeoutSeconds}
            onChange={(timeoutSeconds) =>
              onChange({ ...draft, timeoutSeconds })
            }
            description={t('llm.timeout.hint')}
            errorMessage={errors.timeoutSeconds}
          />
        </>
      )}
    </div>
  );
};
