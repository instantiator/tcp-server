import { useRef, useState, type SubmitEvent } from 'react';
import {
  Button,
  CheckboxButton,
  CheckboxField,
  Label,
  ListBox,
  ListBoxItem,
  Popover,
  Select,
  SelectValue,
  Text,
  type Key,
} from 'react-aria-components';
import { useNavigate } from 'react-router';
import { announce } from '../../../announce/announcer';
import type { CompanyDTO, RoleDTO } from '../../../api/dtos';
import { ApiError } from '../../../api/errors';
import {
  downloadCompanyTemplate,
  useCompanyRolesList,
  useDeleteCompany,
  useLiveCompanyState,
  useUpdateCompany,
} from '../../../api/hooks';
import { ButtonRow } from '../../../components/ButtonRow/ButtonRow';
import { ConfirmDialog } from '../../../components/Dialog/ConfirmDialog';
import { ErrorState } from '../../../components/ErrorState/ErrorState';
import { focusFirstInvalid } from '../../../components/Field/focusFirstInvalid';
import { TextField } from '../../../components/Field/TextField';
import { TimezoneField } from '../../../components/Field/TimezoneField';
import { isKnownTimeZone } from '../../../components/Field/timeZones';
import { LoadingState } from '../../../components/LoadingState/LoadingState';
import { t } from '../../../strings';

/** The announcer channel for this section; this component is its one writer. */
const CHANNEL = 'company';

/** The Select's key for "no default planner"; React Aria keys can't be empty. */
const NO_PLANNER = 'none';

const MAX_RETENTION_DAYS = 3650;

/** Whether a retention field is empty (the app default) or a whole 1–3650. */
const isValidRetention = (text: string): boolean => {
  if (text === '') return true;
  const days = Number(text);
  return Number.isInteger(days) && days >= 1 && days <= MAX_RETENTION_DAYS;
};

export interface CompanyAdminProps {
  readonly companyId: string;
}

/**
 * Admin → Company (002.02): the company's details, its default planner, and
 * deleting it. Models have their own section. Waits for the company and its
 * roles, so the planner choice can't be built from a roles list still loading.
 */
export const CompanyAdmin = ({ companyId }: CompanyAdminProps) => {
  const company = useLiveCompanyState(companyId);
  const roles = useCompanyRolesList(companyId);

  return (
    <section aria-labelledby="company-admin-heading">
      <h2 id="company-admin-heading">{t('admin.company.heading')}</h2>
      {company.data && roles.data ? (
        <CompanyForm
          key={company.data.id}
          initial={company.data}
          roles={roles.data}
        />
      ) : company.isError || roles.isError ? (
        <ErrorState
          message={t('records.error.generic')}
          channel={CHANNEL}
          onRetry={() => {
            void company.refetch();
            void roles.refetch();
          }}
        />
      ) : (
        <LoadingState label={t('admin.company.heading')} />
      )}
    </section>
  );
};

/**
 * The details form and the delete control. A save sends only the fields that
 * differ from the saved company, so an untouched field is never rewritten.
 */
const CompanyForm = ({
  initial,
  roles,
}: {
  readonly initial: CompanyDTO;
  readonly roles: readonly RoleDTO[];
}) => {
  const updateCompany = useUpdateCompany();
  const deleteCompany = useDeleteCompany();
  const navigate = useNavigate();

  const [saved, setSaved] = useState(initial);
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description);
  const [timezone, setTimezone] = useState(initial.timezone ?? '');
  const [context, setContext] = useState(initial.companyContext ?? '');
  const [prompt, setPrompt] = useState(initial.systemPromptTemplate ?? '');
  const [retention, setRetention] = useState(
    String(initial.versionRetentionDays ?? ''),
  );
  const [planner, setPlanner] = useState(initial.plannerRoleId ?? NO_PLANNER);
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<readonly string[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [deleteProblem, setDeleteProblem] = useState<string | null>(null);
  const [includeModels, setIncludeModels] = useState(true);
  const [exportProblem, setExportProblem] = useState<string | null>(null);

  const nameRef = useRef<HTMLElement | null>(null);
  const descriptionRef = useRef<HTMLElement | null>(null);
  const timezoneRef = useRef<HTMLElement | null>(null);
  const retentionRef = useRef<HTMLElement | null>(null);
  const deleteRef = useRef<HTMLButtonElement>(null);

  /** Clears one field's error once the person edits it. */
  const edit =
    (field: string, set: (value: string) => void) =>
    (value: string): void => {
      set(value);
      setErrors((current) =>
        Object.fromEntries(
          Object.entries(current).filter(([key]) => key !== field),
        ),
      );
    };

  const submit = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const found: Record<string, string> = {};
    if (name.trim() === '') found['name'] = t('admin.company.required');
    if (description.trim() === '') {
      found['description'] = t('admin.company.required');
    }
    // Checked only when changed: a zone saved elsewhere that this browser
    // doesn't list must not block saving the other fields.
    if (timezone !== (saved.timezone ?? '') && !isKnownTimeZone(timezone)) {
      found['timezone'] = t('admin.company.timezoneInvalid');
    }
    if (!isValidRetention(retention)) {
      found['retention'] = t('admin.company.retentionInvalid');
    }
    setErrors(found);
    if (Object.keys(found).length > 0) {
      focusFirstInvalid([
        { error: found['name'], ref: nameRef },
        { error: found['description'], ref: descriptionRef },
        { error: found['timezone'], ref: timezoneRef },
        { error: found['retention'], ref: retentionRef },
      ]);
      return;
    }

    const savedPlanner = saved.plannerRoleId ?? NO_PLANNER;
    const changes = {
      ...(name !== saved.name && { name }),
      ...(description !== saved.description && { description }),
      ...(timezone !== (saved.timezone ?? '') && {
        timezone: timezone === '' ? null : timezone,
      }),
      ...(context !== (saved.companyContext ?? '') && {
        companyContext: context === '' ? null : context,
      }),
      ...(prompt !== (saved.systemPromptTemplate ?? '') && {
        systemPromptTemplate: prompt === '' ? null : prompt,
      }),
      ...(retention !== String(saved.versionRetentionDays ?? '') && {
        versionRetentionDays: retention === '' ? null : Number(retention),
      }),
      ...(planner !== savedPlanner && {
        plannerRoleId: planner === NO_PLANNER ? null : planner,
      }),
    };
    if (Object.keys(changes).length === 0) return;

    try {
      const result = await updateCompany.mutateAsync({
        id: saved.id,
        body: changes,
      });
      setSaved(result.company);
      setWarnings(result.warnings);
      setProblem(null);
      announce({ channel: CHANNEL, change: 'admin.company.announce.saved' });
    } catch (error) {
      setProblem(
        error instanceof ApiError && error.status === 400
          ? error.message
          : t('records.error.generic'),
      );
    }
  };

  const confirmDelete = async (): Promise<void> => {
    setConfirming(false);
    try {
      await deleteCompany.mutateAsync(saved.id);
    } catch (error) {
      setDeleteProblem(
        t('admin.company.deleteFailed', {
          message:
            error instanceof ApiError
              ? error.message
              : t('records.error.generic'),
        }),
      );
      deleteRef.current?.focus();
      return;
    }
    announce({
      channel: CHANNEL,
      change: 'admin.company.announce.deleted',
      params: { name: saved.name },
    });
    void navigate('/companies');
  };

  const exportTemplate = (): void => {
    setExportProblem(null);
    downloadCompanyTemplate(saved.id, saved.slug, includeModels).then(
      () =>
        announce({ channel: CHANNEL, change: 'admin.company.export.announce' }),
      () => setExportProblem(t('records.error.generic')),
    );
  };

  const plannerOptions = [
    { id: NO_PLANNER, name: t('admin.company.plannerNone') },
    ...roles.map((role) => ({ id: role.id, name: role.name })),
  ];

  return (
    <>
      <form onSubmit={(event) => void submit(event)}>
        <p>{t('admin.company.slug', { slug: saved.slug })}</p>
        <TextField
          label={t('admin.company.name')}
          value={name}
          onChange={edit('name', setName)}
          isRequired
          {...(errors['name'] !== undefined && {
            errorMessage: errors['name'],
          })}
          inputRef={nameRef}
        />
        <TextField
          label={t('admin.company.description')}
          value={description}
          onChange={edit('description', setDescription)}
          isRequired
          multiline
          {...(errors['description'] !== undefined && {
            errorMessage: errors['description'],
          })}
          inputRef={descriptionRef}
        />
        <TimezoneField
          label={t('admin.company.timezone')}
          value={timezone}
          onChange={edit('timezone', setTimezone)}
          inputRef={timezoneRef}
          {...(errors['timezone'] !== undefined && {
            errorMessage: errors['timezone'],
          })}
        />
        <TextField
          label={t('admin.company.context')}
          description={t('admin.company.contextHint')}
          value={context}
          onChange={setContext}
          multiline
        />
        <TextField
          label={t('admin.company.prompt')}
          description={t('admin.company.promptHint')}
          value={prompt}
          onChange={setPrompt}
          multiline
        />
        <TextField
          label={t('admin.company.retention')}
          description={t('admin.company.retentionHint')}
          value={retention}
          onChange={edit('retention', setRetention)}
          {...(errors['retention'] !== undefined && {
            errorMessage: errors['retention'],
          })}
          inputRef={retentionRef}
        />
        <Select
          className="react-aria-Select tcp-field"
          value={planner}
          onChange={(key: Key | null) => {
            if (key !== null) setPlanner(String(key));
          }}
        >
          <Label className="react-aria-Label tcp-field__label">
            {t('admin.company.planner')}
          </Label>
          <Button className="react-aria-Button">
            <SelectValue />
          </Button>
          <Text slot="description" className="react-aria-Text tcp-field__hint">
            {t('admin.company.plannerHint')}
          </Text>
          <Popover>
            <ListBox items={plannerOptions}>
              {(option) => (
                <ListBoxItem id={option.id} textValue={option.name}>
                  {option.name}
                </ListBoxItem>
              )}
            </ListBox>
          </Popover>
        </Select>
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
            {t('admin.company.save')}
          </Button>
        </ButtonRow>
      </form>
      <h3>{t('admin.company.export.heading')}</h3>
      <p>{t('admin.company.export.intro')}</p>
      <CheckboxField isSelected={includeModels} onChange={setIncludeModels}>
        <CheckboxButton>{t('admin.company.export.models')}</CheckboxButton>
        <Text slot="description" className="react-aria-Text tcp-field__hint">
          {t('admin.company.export.modelsHint')}
        </Text>
      </CheckboxField>
      <ButtonRow>
        <Button className="react-aria-Button" onPress={exportTemplate}>
          {t('admin.company.export.button')}
        </Button>
      </ButtonRow>
      {exportProblem !== null && (
        <p className="tcp-field__error" role="alert">
          {exportProblem}
        </p>
      )}
      <h3>{t('admin.company.dangerHeading')}</h3>
      <ButtonRow>
        <Button
          ref={deleteRef}
          className="react-aria-Button tcp-button--outline"
          onPress={() => {
            setDeleteProblem(null);
            setConfirming(true);
          }}
        >
          {t('admin.company.delete')}
        </Button>
      </ButtonRow>
      {deleteProblem !== null && (
        <p className="tcp-field__error">{deleteProblem}</p>
      )}
      <ConfirmDialog
        isOpen={confirming}
        heading={t('admin.company.deleteHeading', { name: saved.name })}
        message={t('admin.company.deleteMessage')}
        confirmLabel={t('admin.company.deleteConfirm')}
        onConfirm={() => void confirmDelete()}
        onCancel={() => setConfirming(false)}
      />
    </>
  );
};
