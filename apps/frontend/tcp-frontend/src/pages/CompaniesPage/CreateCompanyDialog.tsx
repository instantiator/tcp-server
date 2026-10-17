import type { LlmConfig } from '@tcp/shared/client';
import { useRef, useState, type ReactNode, type SubmitEvent } from 'react';
import { Button } from 'react-aria-components';
import { useNavigate } from 'react-router';
import { announce } from '../../announce/announcer';
import { ApiError } from '../../api/errors';
import { useCreateCompany, useLlmDefaults } from '../../api/hooks';
import { ButtonRow } from '../../components/ButtonRow/ButtonRow';
import { Dialog } from '../../components/Dialog/Dialog';
import { ErrorState } from '../../components/ErrorState/ErrorState';
import { TextField } from '../../components/Field/TextField';
import { TimezoneField } from '../../components/Field/TimezoneField';
import { focusFirstInvalid } from '../../components/Field/focusFirstInvalid';
import { slugify } from '../../components/Field/slugify';
import {
  browserTimeZone,
  isKnownTimeZone,
} from '../../components/Field/timeZones';
import { LlmConfigPicker } from '../../components/LlmConfigPicker/LlmConfigPicker';
import {
  draftOf,
  patchOf,
  validate,
  type LlmDraftErrors,
} from '../../components/LlmConfigPicker/llmDraft';
import { useLocalAddressCheck } from '../../components/LlmConfigPicker/useLocalAddressCheck';
import { LoadingState } from '../../components/LoadingState/LoadingState';
import { t } from '../../strings';

/** The announcer channel shared with the companies page; this dialog writes only its own success. */
const CHANNEL = 'companies';

type Defaults = NonNullable<ReturnType<typeof useLlmDefaults>['data']>;

export interface CreateCompanyDialogProps {
  readonly isOpen: boolean;
  readonly onClose: () => void;
}

/**
 * The New company dialog (002.02). Mounts its form only while open, so each
 * opening starts blank, and only once the app's model defaults are known, so
 * the pickers can say what "inherit" means.
 */
export const CreateCompanyDialog = ({
  isOpen,
  onClose,
}: CreateCompanyDialogProps) =>
  isOpen ? <OpenDialog onClose={onClose} /> : null;

/** Asks for the defaults only once opened, so a closed dialog costs the page no request. */
const OpenDialog = ({ onClose }: { readonly onClose: () => void }) => {
  const defaults = useLlmDefaults();
  return (
    <Dialog heading={t('companies.create.heading')} onClose={onClose}>
      {defaults.data ? (
        <CreateForm defaults={defaults.data} onClose={onClose} />
      ) : defaults.isError ? (
        <ErrorState
          message={t('records.error.generic')}
          channel={CHANNEL}
          onRetry={() => {
            void defaults.refetch();
          }}
        />
      ) : (
        <LoadingState label={t('companies.create.loading')} />
      )}
    </Dialog>
  );
};

/** A picker under its own heading, as a group a screen reader can name. */
const ModelGroup = ({
  id,
  heading,
  children,
}: {
  readonly id: string;
  readonly heading: string;
  readonly children: ReactNode;
}) => (
  <div role="group" aria-labelledby={id}>
    <h3 id={id}>{heading}</h3>
    {children}
  </div>
);

/**
 * The details and the two model pickers. A model left on "inherit" is left
 * out of the request altogether: a new company has nothing to clear.
 */
const CreateForm = ({
  defaults,
  onClose,
}: {
  readonly defaults: Defaults;
  readonly onClose: () => void;
}) => {
  const createCompany = useCreateCompany();
  const navigate = useNavigate();
  const { check, dialog } = useLocalAddressCheck();

  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [description, setDescription] = useState('');
  const [timezone, setTimezone] = useState(browserTimeZone);
  const [context, setContext] = useState('');
  const [chat, setChat] = useState(() => draftOf(null));
  const [embedding, setEmbedding] = useState(() => draftOf(null));
  const [chatErrors, setChatErrors] = useState<LlmDraftErrors>({});
  const [embeddingErrors, setEmbeddingErrors] = useState<LlmDraftErrors>({});
  const [errors, setErrors] = useState<{
    name?: string;
    slug?: string;
    description?: string;
    timezone?: string;
  }>({});
  const [problem, setProblem] = useState<string | null>(null);
  const nameRef = useRef<HTMLElement | null>(null);
  const slugRef = useRef<HTMLElement | null>(null);
  const descriptionRef = useRef<HTMLElement | null>(null);
  const timezoneRef = useRef<HTMLElement | null>(null);

  const shownSlug = slugTouched ? slug : slugify(name);

  /** The config as it will be sent: its local address moved to Docker's host if the person agrees. */
  const checked = async (
    config: LlmConfig | null | undefined,
  ): Promise<LlmConfig | undefined> => {
    if (!config) return undefined;
    return config.baseUrl
      ? { ...config, baseUrl: await check(config.baseUrl) }
      : config;
  };

  const failed = (error: unknown): void => {
    if (error instanceof ApiError && error.status === 409) {
      setErrors((e) => ({ ...e, slug: t('companies.create.slugTaken') }));
      slugRef.current?.focus();
      return;
    }
    setProblem(
      error instanceof ApiError && error.status === 400
        ? error.message
        : t('records.error.generic'),
    );
  };

  const submit = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const found = {
      ...(name.trim() === '' && { name: t('companies.create.nameRequired') }),
      ...(shownSlug === '' && { slug: t('companies.create.slugRequired') }),
      ...(description.trim() === '' && {
        description: t('companies.create.descriptionRequired'),
      }),
      ...(!isKnownTimeZone(timezone) && {
        timezone: t('companies.create.timezoneInvalid'),
      }),
    };
    setErrors(found);
    // An inherited model is never sent, so it can't block saving the rest.
    const chatFound = patchOf(chat, null) ? validate(chat, 'chat') : {};
    const embeddingFound = patchOf(embedding, null)
      ? validate(embedding, 'embedding', defaults.embeddingDimension)
      : {};
    setChatErrors(chatFound);
    setEmbeddingErrors(embeddingFound);
    if (Object.keys(found).length > 0) {
      focusFirstInvalid([
        { error: found.name, ref: nameRef },
        { error: found.slug, ref: slugRef },
        { error: found.description, ref: descriptionRef },
        { error: found.timezone, ref: timezoneRef },
      ]);
      return;
    }
    if (Object.keys(chatFound).length + Object.keys(embeddingFound).length > 0)
      return;

    const llmConfig = await checked(patchOf(chat, null));
    const embeddingConfig = await checked(patchOf(embedding, null));
    try {
      const { company } = await createCompany.mutateAsync({
        slug: shownSlug,
        name: name.trim(),
        description: description.trim(),
        ...(timezone && { timezone }),
        ...(context.trim() && { companyContext: context }),
        ...(llmConfig && { llmConfig }),
        ...(embeddingConfig && { embeddingConfig }),
      });
      announce({ channel: CHANNEL, change: 'companies.create.announce' });
      onClose();
      void navigate(`/company/${company.id}#admin/roles`);
    } catch (error) {
      failed(error);
    }
  };

  return (
    <form onSubmit={(event) => void submit(event)}>
      <TextField
        label={t('companies.create.name')}
        value={name}
        onChange={(value) => {
          setName(value);
          setErrors((e) => ({ ...e, name: undefined }));
        }}
        errorMessage={errors.name}
        inputRef={nameRef}
        isRequired
      />
      <TextField
        label={t('companies.create.slug')}
        value={shownSlug}
        onChange={(value) => {
          setSlug(value);
          setSlugTouched(true);
          setErrors((e) => ({ ...e, slug: undefined }));
        }}
        description={t('companies.create.slugHint')}
        errorMessage={errors.slug}
        inputRef={slugRef}
        isRequired
      />
      <TextField
        label={t('companies.create.description')}
        value={description}
        onChange={(value) => {
          setDescription(value);
          setErrors((e) => ({ ...e, description: undefined }));
        }}
        errorMessage={errors.description}
        inputRef={descriptionRef}
        multiline
        isRequired
      />
      <TimezoneField
        label={t('companies.create.timezone')}
        value={timezone}
        onChange={(value) => {
          setTimezone(value);
          setErrors((e) => ({ ...e, timezone: undefined }));
        }}
        errorMessage={errors.timezone}
        inputRef={timezoneRef}
      />
      <TextField
        label={t('companies.create.context')}
        value={context}
        onChange={setContext}
        description={t('companies.create.contextHint')}
        multiline
      />
      <ModelGroup id="create-company-chat" heading={t('companies.create.chat')}>
        <LlmConfigPicker
          purpose="chat"
          draft={chat}
          onChange={(next) => {
            setChat(next);
            setChatErrors({});
          }}
          saved={null}
          fallback={{ from: 'app', config: defaults.chat }}
          errors={chatErrors}
        />
      </ModelGroup>
      <ModelGroup
        id="create-company-embedding"
        heading={t('companies.create.embedding')}
      >
        <LlmConfigPicker
          purpose="embedding"
          draft={embedding}
          onChange={(next) => {
            setEmbedding(next);
            setEmbeddingErrors({});
          }}
          saved={null}
          fallback={{ from: 'app', config: defaults.embedding }}
          embeddingDimension={defaults.embeddingDimension}
          errors={embeddingErrors}
        />
      </ModelGroup>
      {problem !== null && <p className="tcp-field__error">{problem}</p>}
      <ButtonRow>
        <Button
          className="react-aria-Button"
          type="submit"
          isPending={createCompany.isPending}
        >
          {t('companies.create.submit')}
        </Button>
        <Button
          className="react-aria-Button tcp-button--outline"
          onPress={onClose}
        >
          {t('companies.create.cancel')}
        </Button>
      </ButtonRow>
      {dialog}
    </form>
  );
};
