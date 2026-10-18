import type { LlmConfig } from '@tcp/shared/client';
import {
  useId,
  useRef,
  useState,
  type ReactNode,
  type SubmitEvent,
} from 'react';
import { Button, CheckboxButton, CheckboxField } from 'react-aria-components';
import { useNavigate } from 'react-router';
import { announce } from '../../announce/announcer';
import { ApiError } from '../../api/errors';
import {
  useCreateCompany,
  useImportCompany,
  useLlmDefaults,
} from '../../api/hooks';
import type { ImportCompanyOptions } from '../../api/dtos';
import { ButtonRow } from '../../components/ButtonRow/ButtonRow';
import { ConfirmDialog } from '../../components/Dialog/ConfirmDialog';
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
import { t, tCount } from '../../strings';
import type { ChosenTemplate } from './TemplateGalleryDialog';

/** The announcer channel shared with the companies page; this dialog writes only its own success. */
const CHANNEL = 'companies';

type Defaults = NonNullable<ReturnType<typeof useLlmDefaults>['data']>;

export interface CreateCompanyDialogProps {
  readonly isOpen: boolean;
  readonly onClose: () => void;
  /** A template to import (002.03): the form starts from it and submits an import. */
  readonly template?: ChosenTemplate | undefined;
}

/**
 * The New company dialog (002.02). Mounts its form only while open, so each
 * opening starts blank, and only once the app's model defaults are known, so
 * the pickers can say what "inherit" means. Given a `template`, it is the
 * review step of an import instead (002.03).
 */
export const CreateCompanyDialog = ({
  isOpen,
  onClose,
  template,
}: CreateCompanyDialogProps) =>
  isOpen ? <OpenDialog onClose={onClose} template={template} /> : null;

/** Asks for the defaults only once opened, so a closed dialog costs the page no request. */
const OpenDialog = ({
  onClose,
  template,
}: {
  readonly onClose: () => void;
  readonly template: ChosenTemplate | undefined;
}) => {
  const defaults = useLlmDefaults();
  return (
    <Dialog
      heading={
        template
          ? t('companies.import.heading', {
              name: template.preview.company.name,
            })
          : t('companies.create.heading')
      }
      onClose={onClose}
    >
      {defaults.data ? (
        <CreateForm
          defaults={defaults.data}
          onClose={onClose}
          template={template}
        />
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
  template,
}: {
  readonly defaults: Defaults;
  readonly onClose: () => void;
  readonly template: ChosenTemplate | undefined;
}) => {
  const createCompany = useCreateCompany();
  const importCompany = useImportCompany();
  const navigate = useNavigate();
  const { check, dialog } = useLocalAddressCheck();
  const preview = template?.preview;

  const [name, setName] = useState(preview?.company.name ?? '');
  const [slug, setSlug] = useState(preview?.company.slug ?? '');
  // A template's slug is its own choice; it doesn't follow edits to the name.
  const [slugTouched, setSlugTouched] = useState(preview !== undefined);
  const [description, setDescription] = useState(
    preview?.company.description ?? '',
  );
  const [timezone, setTimezone] = useState(
    () => preview?.company.timezone ?? browserTimeZone(),
  );
  const [context, setContext] = useState(preview?.company.companyContext ?? '');
  const [chat, setChat] = useState(() =>
    draftOf(preview?.company.llmConfig ?? null),
  );
  const [embedding, setEmbedding] = useState(() =>
    draftOf(preview?.company.embeddingConfig ?? null),
  );
  // Roles whose own model the importer turned off; they inherit instead.
  const [inheriting, setInheriting] = useState<readonly string[]>([]);
  // The import held back by a taken slug, until the person agrees to replace.
  const [replacing, setReplacing] = useState<ImportCompanyOptions | null>(null);
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

  /** Sends the import; a taken slug asks before replacing what holds it. */
  const sendImport = async (
    source: ChosenTemplate['source'],
    options: ImportCompanyOptions,
  ): Promise<void> => {
    try {
      const { id } = await importCompany.mutateAsync({ source, options });
      announce({ channel: CHANNEL, change: 'companies.import.announce' });
      onClose();
      void navigate(`/company/${id}`);
    } catch (error) {
      if (
        error instanceof ApiError &&
        error.status === 409 &&
        !options.replace
      ) {
        setReplacing(options);
      } else if (error instanceof ApiError && error.status === 403) {
        setProblem(t('companies.import.replaceForbidden'));
      } else {
        failed(error);
      }
    }
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
    if (template) {
      setProblem(null);
      // Both models are always sent, `null` meaning inherit, so the
      // importer's choice wins over the template's.
      await sendImport(template.source, {
        slug: shownSlug,
        name: name.trim(),
        description: description.trim(),
        timezone,
        companyContext: context.trim() ? context : null,
        llmConfig: llmConfig ?? null,
        embeddingConfig: embeddingConfig ?? null,
        ...(inheriting.length > 0 && {
          roleModels: Object.fromEntries(inheriting.map((r) => [r, false])),
        }),
      });
      return;
    }
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
      {preview && preview.warnings.length > 0 && (
        <>
          <p>{t('companies.import.warnings')}</p>
          <ul>
            {preview.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </>
      )}
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
      {preview?.neededKeys.map((provider) => (
        <p key={provider}>{t('companies.import.needsKey', { provider })}</p>
      ))}
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
      {preview && (
        <TemplateRoles
          preview={preview}
          inheriting={inheriting}
          onChange={setInheriting}
        />
      )}
      {problem !== null && <p className="tcp-field__error">{problem}</p>}
      <ButtonRow>
        <Button
          className="react-aria-Button"
          type="submit"
          isPending={createCompany.isPending || importCompany.isPending}
        >
          {template
            ? t('companies.import.submit')
            : t('companies.create.submit')}
        </Button>
        <Button
          className="react-aria-Button tcp-button--outline"
          onPress={onClose}
        >
          {t('companies.create.cancel')}
        </Button>
      </ButtonRow>
      {dialog}
      <ConfirmDialog
        isOpen={replacing !== null}
        heading={t('companies.import.replaceHeading', { slug: shownSlug })}
        message={t('companies.import.replaceMessage')}
        confirmLabel={t('companies.import.replaceConfirm')}
        onConfirm={() => {
          const options = replacing;
          setReplacing(null);
          if (template && options) {
            void sendImport(template.source, { ...options, replace: true });
          }
        }}
        onCancel={() => {
          setReplacing(null);
          setErrors((e) => ({ ...e, slug: t('companies.import.slugTaken') }));
          slugRef.current?.focus();
        }}
      />
    </form>
  );
};

/**
 * What a template brings besides the company: each role, with a switch for
 * the model it carries, and its knowledge documents with their licences.
 */
const TemplateRoles = ({
  preview,
  inheriting,
  onChange,
}: {
  readonly preview: ChosenTemplate['preview'];
  readonly inheriting: readonly string[];
  readonly onChange: (inheriting: readonly string[]) => void;
}) => {
  const idBase = useId();
  const licences = [
    ...new Set(
      preview.documents.flatMap(({ license }) => (license ? [license] : [])),
    ),
  ];
  return (
    <>
      <fieldset>
        <legend>{t('companies.import.roles')}</legend>
        {preview.roles.length === 0 && <p>{t('companies.import.noRoles')}</p>}
        <ul>
          {preview.roles.map((role) => (
            <li key={role.slug}>
              <strong id={`${idBase}-${role.slug}`}>{role.name}</strong>
              <p>{role.description}</p>
              {role.llmConfig && (
                // The role's name describes the checkbox, so identical model
                // labels across roles stay distinguishable.
                <CheckboxField
                  aria-describedby={`${idBase}-${role.slug}`}
                  isSelected={!inheriting.includes(role.slug)}
                  onChange={(on) =>
                    onChange(
                      on
                        ? inheriting.filter((slug) => slug !== role.slug)
                        : [...inheriting, role.slug],
                    )
                  }
                >
                  <CheckboxButton>
                    {t('companies.import.roleModel', {
                      provider: role.llmConfig.provider,
                      model: role.llmConfig.model,
                    })}
                  </CheckboxButton>
                </CheckboxField>
              )}
            </li>
          ))}
        </ul>
      </fieldset>
      <p>
        {tCount('companies.import.documents', preview.documents.length)}
        {licences.length > 0 &&
          ` ${t('companies.import.licences', { licences: licences.join(', ') })}`}
      </p>
    </>
  );
};
