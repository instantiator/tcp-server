import type { LlmConfig } from '@tcp/shared/client';
import { useState, type ReactNode, type SubmitEvent } from 'react';
import { Button } from 'react-aria-components';
import { announce } from '../../../announce/announcer';
import type { CompanyDTO, RoleDTO } from '../../../api/dtos';
import { ApiError } from '../../../api/errors';
import {
  useCompanyRolesList,
  useLiveCompanyState,
  useLlmDefaults,
  useUpdateCompany,
} from '../../../api/hooks';
import { ButtonRow } from '../../../components/ButtonRow/ButtonRow';
import { ConfirmDialog } from '../../../components/Dialog/ConfirmDialog';
import { ErrorState } from '../../../components/ErrorState/ErrorState';
import { LoadingState } from '../../../components/LoadingState/LoadingState';
import { LlmConfigPicker } from '../../../components/LlmConfigPicker/LlmConfigPicker';
import {
  draftOf,
  patchOf,
  validate,
  type LlmDraft,
  type LlmDraftErrors,
} from '../../../components/LlmConfigPicker/llmDraft';
import { useLocalAddressCheck } from '../../../components/LlmConfigPicker/useLocalAddressCheck';
import { t, tCount } from '../../../strings';

/** The announcer channel for this section; this component is its one writer. */
const CHANNEL = 'models';

type Defaults = NonNullable<ReturnType<typeof useLlmDefaults>['data']>;

/** A yes/no question being asked, and the promise waiting on its answer. */
interface Question {
  readonly heading: string;
  readonly message: string;
  readonly confirmLabel: string;
  readonly answer: (yes: boolean) => void;
}

export interface LanguageModelsAdminProps {
  readonly companyId: string;
}

/**
 * Admin → Language models (002.01): the company's chat and embedding models,
 * each chosen with the shared picker, saved together. Waits for the company,
 * the app defaults and the roles, so the form starts from the right drafts
 * and the no-model check can't run against a roles list still loading.
 */
export const LanguageModelsAdmin = ({
  companyId,
}: LanguageModelsAdminProps) => {
  const company = useLiveCompanyState(companyId);
  const defaults = useLlmDefaults();
  const roles = useCompanyRolesList(companyId);

  return (
    <section aria-labelledby="models-admin-heading">
      <h2 id="models-admin-heading">{t('admin.models.heading')}</h2>
      {company.data && defaults.data && roles.data ? (
        <ModelsForm
          key={company.data.id}
          company={company.data}
          defaults={defaults.data}
          roles={roles.data}
        />
      ) : company.isError || defaults.isError || roles.isError ? (
        <ErrorState
          message={t('records.error.generic')}
          channel={CHANNEL}
          onRetry={() => {
            void company.refetch();
            void defaults.refetch();
            void roles.refetch();
          }}
        />
      ) : (
        <LoadingState label={t('admin.models.heading')} />
      )}
    </section>
  );
};

/** A picker under its own heading, as a group a screen reader can name. */
const ModelGroup = ({
  id,
  heading,
  hint,
  children,
}: {
  readonly id: string;
  readonly heading: string;
  readonly hint: string;
  readonly children: ReactNode;
}) => (
  <div role="group" aria-labelledby={id}>
    <h3 id={id}>{heading}</h3>
    <p>{hint}</p>
    {children}
  </div>
);

/**
 * The two pickers and one Save. A save asks first when it would leave roles
 * without any model, or change the embedding model (which re-indexes), and
 * sends only the config(s) that changed.
 */
const ModelsForm = ({
  company,
  defaults,
  roles,
}: {
  readonly company: CompanyDTO;
  readonly defaults: Defaults;
  readonly roles: readonly RoleDTO[];
}) => {
  const updateCompany = useUpdateCompany();
  const { check, dialog } = useLocalAddressCheck();

  const [chat, setChat] = useState(() => draftOf(company.llmConfig));
  const [embedding, setEmbedding] = useState(() =>
    draftOf(company.embeddingConfig),
  );
  const [chatErrors, setChatErrors] = useState<LlmDraftErrors>({});
  const [embeddingErrors, setEmbeddingErrors] = useState<LlmDraftErrors>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<readonly string[]>([]);
  const [question, setQuestion] = useState<Question | null>(null);

  /** Asks one question at a time; resolves to whether the person said yes. */
  const ask = (text: Omit<Question, 'answer'>): Promise<boolean> =>
    new Promise((resolve) =>
      setQuestion({
        ...text,
        answer: (yes) => {
          setQuestion(null);
          resolve(yes);
        },
      }),
    );

  /** The draft with its address moved to Docker's host, if the person agrees. */
  const withCheckedAddress = async (
    draft: LlmDraft,
    saved: LlmConfig | null | undefined,
  ): Promise<LlmDraft> => {
    const baseUrl = patchOf(draft, saved)?.baseUrl;
    if (!baseUrl) return draft;
    const url = await check(baseUrl);
    return url === baseUrl ? draft : { ...draft, baseUrl: url };
  };

  /** Whether a save of this embedding config would change what the vectors mean. */
  const reindexes = (patch: LlmConfig): boolean => {
    const saved = company.embeddingConfig;
    return (
      !saved ||
      patch.provider !== saved.provider ||
      patch.model !== saved.model ||
      (patch.baseUrl ?? saved.baseUrl) !== saved.baseUrl
    );
  };

  const submit = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    // An untouched config is never sent, so it can't block saving the other.
    const chatFound =
      patchOf(chat, company.llmConfig) === undefined
        ? {}
        : validate(chat, 'chat');
    const embeddingFound =
      patchOf(embedding, company.embeddingConfig) === undefined
        ? {}
        : validate(embedding, 'embedding', defaults.embeddingDimension);
    setChatErrors(chatFound);
    setEmbeddingErrors(embeddingFound);
    if (
      Object.keys(chatFound).length + Object.keys(embeddingFound).length >
      0
    ) {
      return;
    }

    const chatDraft = await withCheckedAddress(chat, company.llmConfig);
    const embeddingDraft = await withCheckedAddress(
      embedding,
      company.embeddingConfig,
    );
    setChat(chatDraft);
    setEmbedding(embeddingDraft);
    const chatPatch = patchOf(chatDraft, company.llmConfig);
    const embeddingPatch = patchOf(embeddingDraft, company.embeddingConfig);
    if (chatPatch === undefined && embeddingPatch === undefined) return;

    const bare = roles.filter((role) => !role.llmConfig);
    if (chatPatch === null && defaults.chat === null && bare.length > 0) {
      const yes = await ask({
        heading: t('admin.models.noModel.heading'),
        message: t('admin.models.noModel.message', {
          roles: tCount('admin.models.noModel.roles', bare.length),
          names: bare.map((role) => role.name).join(', '),
        }),
        confirmLabel: t('admin.models.noModel.confirm'),
      });
      if (!yes) return;
    }
    if (embeddingPatch && reindexes(embeddingPatch)) {
      const yes = await ask({
        heading: t('admin.models.reindex.heading'),
        message: t('admin.models.reindex.message'),
        confirmLabel: t('admin.models.reindex.confirm'),
      });
      if (!yes) return;
    }

    try {
      const result = await updateCompany.mutateAsync({
        id: company.id,
        body: {
          ...(chatPatch !== undefined && { llmConfig: chatPatch }),
          ...(embeddingPatch !== undefined && {
            embeddingConfig: embeddingPatch,
          }),
        },
      });
      // Typed keys leave the form; the saved ones come back masked.
      setChat(draftOf(result.company.llmConfig));
      setEmbedding(draftOf(result.company.embeddingConfig));
      setWarnings(result.warnings);
      setProblem(null);
      announce({ channel: CHANNEL, change: 'admin.models.announce.saved' });
    } catch (error) {
      setProblem(
        error instanceof ApiError && error.status === 400
          ? error.message
          : t('records.error.generic'),
      );
    }
  };

  return (
    <form onSubmit={(event) => void submit(event)}>
      <ModelGroup
        id="models-admin-chat"
        heading={t('admin.models.chat')}
        hint={t('admin.models.chat.hint')}
      >
        <LlmConfigPicker
          purpose="chat"
          draft={chat}
          onChange={(next) => {
            setChat(next);
            setChatErrors({});
          }}
          saved={company.llmConfig}
          fallback={{ from: 'app', config: defaults.chat }}
          companyId={company.id}
          errors={chatErrors}
        />
      </ModelGroup>
      <ModelGroup
        id="models-admin-embedding"
        heading={t('admin.models.embedding')}
        hint={t('admin.models.embedding.hint')}
      >
        <LlmConfigPicker
          purpose="embedding"
          draft={embedding}
          onChange={(next) => {
            setEmbedding(next);
            setEmbeddingErrors({});
          }}
          saved={company.embeddingConfig}
          fallback={{ from: 'app', config: defaults.embedding }}
          companyId={company.id}
          embeddingDimension={defaults.embeddingDimension}
          errors={embeddingErrors}
        />
      </ModelGroup>
      {warnings.length > 0 && (
        <div>
          <p>{t('admin.role.warnings')}</p>
          <ul>
            {warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </div>
      )}
      {problem !== null && <p className="tcp-field__error">{problem}</p>}
      <ButtonRow>
        <Button
          className="react-aria-Button"
          type="submit"
          isPending={updateCompany.isPending}
        >
          {t('admin.models.save')}
        </Button>
      </ButtonRow>
      {dialog}
      <ConfirmDialog
        isOpen={question !== null}
        heading={question?.heading ?? ''}
        message={question?.message ?? ''}
        confirmLabel={question?.confirmLabel}
        onConfirm={() => question?.answer(true)}
        onCancel={() => question?.answer(false)}
      />
    </form>
  );
};
