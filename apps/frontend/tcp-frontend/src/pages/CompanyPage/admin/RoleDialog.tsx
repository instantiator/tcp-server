import { useRef, useState, type SubmitEvent } from 'react';
import {
  Button,
  Label,
  RadioButton,
  RadioField,
  RadioGroup,
  Tab,
  TabList,
  TabPanel,
  Tabs,
  Text,
  type Key,
} from 'react-aria-components';
import { announce } from '../../../announce/announcer';
import type { RoleDTO } from '../../../api/dtos';
import { ApiError } from '../../../api/errors';
import {
  useCompanyRolesList,
  useCreateRole,
  useLiveCompanyState,
  useMcpServers,
  useUpdateRole,
} from '../../../api/hooks';
import { ButtonRow } from '../../../components/ButtonRow/ButtonRow';
import { Dialog } from '../../../components/Dialog/Dialog';
import { ErrorState } from '../../../components/ErrorState/ErrorState';
import { TextField } from '../../../components/Field/TextField';
import { focusFirstInvalid } from '../../../components/Field/focusFirstInvalid';
import { LoadingState } from '../../../components/LoadingState/LoadingState';
import { t } from '../../../strings';
import './RoleDialog.css';
import { KnowledgePanel } from './KnowledgePanel';

/** The announcer channel for this dialog; this component is its one writer. */
const CHANNEL = 'role-dialog';

/** The slug no role may take: the shared knowledge scope uses it. */
const RESERVED_SLUG = 'shared';

/** How a role treats one tool server: follow the company, or force on or off. */
type Choice = 'default' | 'on' | 'off';

type Toggles = Record<string, boolean>;

const toChoice = (value: string): Choice =>
  value === 'on' || value === 'off' ? value : 'default';

/** A slug from a name: lower case, runs of other characters become one dash. */
const slugify = (name: string): string =>
  name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

/** Comma-separated text to a list: trimmed, empties dropped. */
const parseDomains = (text: string): string[] =>
  text
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');

const choicesOf = (
  toggles: Toggles | null | undefined,
): Record<string, Choice> =>
  Object.fromEntries(
    Object.entries(toggles ?? {}).map(([name, on]) => [
      name,
      on ? 'on' : 'off',
    ]),
  );

/** Only the explicit choices become toggles; `default` is the key being absent. */
const togglesOf = (choices: Record<string, Choice>): Toggles | null => {
  const entries = Object.entries(choices).flatMap(([name, choice]) =>
    choice === 'default' ? [] : [[name, choice === 'on'] as const],
  );
  return entries.length === 0 ? null : Object.fromEntries(entries);
};

const sameList = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((item, i) => item === b[i]);

const sameToggles = (a: Toggles | null, b: Toggles | null): boolean =>
  JSON.stringify(Object.entries(a ?? {}).sort()) ===
  JSON.stringify(Object.entries(b ?? {}).sort());

export interface RoleDialogProps {
  readonly companyId: string;
  /** The role to show, or `null` to add a new one. */
  readonly roleId: string | null;
  readonly onClose: () => void;
}

/**
 * One role's details, or a new role's (002.00). An existing role is read from
 * the roles list the table already cached, so opening it costs no request.
 */
export const RoleDialog = ({ companyId, roleId, onClose }: RoleDialogProps) => {
  const roles = useCompanyRolesList(companyId);
  const heading = t('admin.roles.heading');

  if (roleId === null) {
    return (
      <RoleEditor companyId={companyId} initial={null} onClose={onClose} />
    );
  }
  if (roles.isPending) {
    return (
      <Dialog heading={heading} onClose={onClose}>
        <LoadingState label={t('admin.role.loading')} />
      </Dialog>
    );
  }
  const initial = roles.data?.find((role) => role.id === roleId);
  if (roles.isError || initial === undefined) {
    return (
      <Dialog heading={heading} onClose={onClose}>
        <ErrorState message={t('admin.role.loadError')} channel={CHANNEL} />
      </Dialog>
    );
  }
  return (
    <RoleEditor companyId={companyId} initial={initial} onClose={onClose} />
  );
};

/**
 * The tabs and the details form. It keeps the last saved role as its
 * baseline: a create turns the dialog into that role's (so the Knowledge tab
 * opens), and an edit sends only what differs from it. The slug is chosen
 * once, on create, and never sent again.
 */
const RoleEditor = ({
  companyId,
  initial,
  onClose,
}: {
  readonly companyId: string;
  readonly initial: RoleDTO | null;
  readonly onClose: () => void;
}) => {
  const company = useLiveCompanyState(companyId).data;
  const servers = useMcpServers().data ?? [];
  const createRole = useCreateRole();
  const updateRole = useUpdateRole();

  const [saved, setSaved] = useState(initial);
  const [tab, setTab] = useState<Key>('details');
  const [name, setName] = useState(initial?.name ?? '');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [description, setDescription] = useState(initial?.description ?? '');
  const [prompt, setPrompt] = useState(initial?.rolePrompt ?? '');
  const [domains, setDomains] = useState(
    (initial?.knowledgeDomains ?? []).join(', '),
  );
  const [choices, setChoices] = useState(choicesOf(initial?.mcpServerToggles));
  const [errors, setErrors] = useState<{
    name?: string;
    slug?: string;
    description?: string;
  }>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<readonly string[]>([]);
  const nameRef = useRef<HTMLElement | null>(null);
  const slugRef = useRef<HTMLElement | null>(null);
  const descriptionRef = useRef<HTMLElement | null>(null);

  const shownSlug = slugTouched ? slug : slugify(name);
  const adding = saved === null;

  /** Records a successful save: the new baseline, the announcement, any warnings. */
  const succeeded = (
    role: RoleDTO,
    change: 'admin.role.announce.created' | 'admin.role.announce.saved',
    notes: readonly string[],
  ): void => {
    setSaved(role);
    setWarnings(notes);
    setProblem(null);
    announce({ channel: CHANNEL, change, params: { name: role.name } });
  };

  const failed = (error: unknown): void => {
    setProblem(
      error instanceof ApiError && error.status === 400
        ? error.message
        : t('records.error.generic'),
    );
  };

  const submit = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const found = {
      ...(name.trim() === '' && { name: t('admin.role.nameRequired') }),
      ...(adding && shownSlug === '' && { slug: t('admin.role.slugRequired') }),
      ...(adding &&
        shownSlug === RESERVED_SLUG && { slug: t('admin.role.slugReserved') }),
      ...(description.trim() === '' && {
        description: t('admin.role.descriptionRequired'),
      }),
    };
    setErrors(found);
    if (Object.keys(found).length > 0) {
      focusFirstInvalid([
        { error: found.name, ref: nameRef },
        { error: 'slug' in found ? found.slug : undefined, ref: slugRef },
        { error: found.description, ref: descriptionRef },
      ]);
      return;
    }

    const body = {
      name: name.trim(),
      description: description.trim(),
      rolePrompt: prompt,
      knowledgeDomains: parseDomains(domains),
      mcpServerToggles: togglesOf(choices),
    };
    try {
      if (saved === null) {
        const result = await createRole.mutateAsync({
          companyId,
          slug: shownSlug,
          ...body,
          mcpServerList: [],
        });
        succeeded(result.role, 'admin.role.announce.created', result.warnings);
        return;
      }
      // Only what changed, so a stale form can't overwrite another admin's edit.
      const changes = {
        ...(body.name !== saved.name && { name: body.name }),
        ...(body.description !== saved.description && {
          description: body.description,
        }),
        ...(body.rolePrompt !== (saved.rolePrompt ?? '') && {
          rolePrompt: body.rolePrompt,
        }),
        ...(!sameList(body.knowledgeDomains, saved.knowledgeDomains) && {
          knowledgeDomains: body.knowledgeDomains,
        }),
        ...(!sameToggles(
          body.mcpServerToggles,
          saved.mcpServerToggles ?? null,
        ) && {
          mcpServerToggles: body.mcpServerToggles,
        }),
      };
      const result = await updateRole.mutateAsync({
        id: saved.id,
        body: changes,
      });
      succeeded(result.role, 'admin.role.announce.saved', result.warnings);
    } catch (error) {
      failed(error);
    }
  };

  /** Drops the role's own model so it follows the company's. */
  const followCompanyModel = async (role: RoleDTO) => {
    try {
      const result = await updateRole.mutateAsync({
        id: role.id,
        body: { llmConfig: null },
      });
      succeeded(result.role, 'admin.role.announce.saved', result.warnings);
    } catch (error) {
      failed(error);
    }
  };

  const modelSentence = saved?.llmConfig
    ? t('admin.role.llm.role', {
        provider: saved.llmConfig.provider,
        model: saved.llmConfig.model,
      })
    : company?.llmConfig
      ? t('admin.role.llm.company', {
          provider: company.llmConfig.provider,
          model: company.llmConfig.model,
        })
      : t('admin.role.llm.app');

  return (
    <Dialog
      heading={saved?.name ?? t('admin.role.newHeading')}
      onClose={onClose}
    >
      <Tabs
        className="react-aria-Tabs"
        selectedKey={tab}
        onSelectionChange={setTab}
        disabledKeys={adding ? ['knowledge'] : []}
      >
        <TabList
          aria-label={t('admin.role.tabs')}
          className="react-aria-TabList"
        >
          <Tab id="details" className="react-aria-Tab">
            {t('admin.role.tab.details')}
          </Tab>
          <Tab id="knowledge" className="react-aria-Tab">
            {t('admin.role.tab.knowledge')}
          </Tab>
        </TabList>
        {adding && <p>{t('admin.role.knowledgeDisabled')}</p>}
        <TabPanel id="details" className="react-aria-TabPanel">
          <form onSubmit={(event) => void submit(event)}>
            <TextField
              label={t('admin.role.name')}
              value={name}
              onChange={(value) => {
                setName(value);
                setErrors((e) => ({ ...e, name: undefined }));
              }}
              errorMessage={errors.name}
              inputRef={nameRef}
              isRequired
            />
            {adding && (
              <TextField
                label={t('admin.role.slug')}
                value={shownSlug}
                onChange={(value) => {
                  setSlug(value);
                  setSlugTouched(true);
                  setErrors((e) => ({ ...e, slug: undefined }));
                }}
                description={t('admin.role.slugHint')}
                errorMessage={errors.slug}
                inputRef={slugRef}
                isRequired
              />
            )}
            <TextField
              label={t('admin.role.description')}
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
            <TextField
              label={t('admin.role.prompt')}
              value={prompt}
              onChange={setPrompt}
              description={t('admin.role.promptHint')}
              multiline
            />
            <TextField
              label={t('admin.role.domains')}
              value={domains}
              onChange={setDomains}
              description={t('admin.role.domainsHint')}
            />
            <div className="role-dialog__tools">
              <h3>{t('admin.role.mcp.heading')}</h3>
              <p>{t('admin.role.mcp.intro')}</p>
              {servers.map((server) => (
                <RadioGroup
                  key={server.name}
                  className="react-aria-RadioGroup role-dialog__server"
                  orientation="horizontal"
                  value={choices[server.name] ?? 'default'}
                  onChange={(value) =>
                    setChoices((c) => ({
                      ...c,
                      [server.name]: toChoice(value),
                    }))
                  }
                >
                  <Label>
                    {server.available
                      ? server.name
                      : t('admin.role.mcp.unavailable', { name: server.name })}
                  </Label>
                  <Text
                    slot="description"
                    className="react-aria-Text tcp-field__hint"
                  >
                    {server.usage}
                  </Text>
                  <RadioField value="default">
                    <RadioButton>
                      {(company?.mcpServerToggles?.[server.name] ?? true)
                        ? t('admin.role.mcp.defaultOn')
                        : t('admin.role.mcp.defaultOff')}
                    </RadioButton>
                  </RadioField>
                  <RadioField value="on">
                    <RadioButton>{t('admin.role.mcp.on')}</RadioButton>
                  </RadioField>
                  <RadioField value="off">
                    <RadioButton>{t('admin.role.mcp.off')}</RadioButton>
                  </RadioField>
                </RadioGroup>
              ))}
            </div>
            <div className="role-dialog__model">
              <h3>{t('admin.role.llm.heading')}</h3>
              <p>{modelSentence}</p>
              <p>{t('admin.role.llm.later')}</p>
              {saved?.llmConfig && (
                <Button
                  className="react-aria-Button tcp-button--outline"
                  isPending={updateRole.isPending}
                  onPress={() => void followCompanyModel(saved)}
                >
                  {t('admin.role.llm.useCompany')}
                </Button>
              )}
            </div>
            {warnings.length > 0 && (
              <div className="role-dialog__warnings">
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
                isPending={createRole.isPending || updateRole.isPending}
              >
                {adding ? t('admin.role.create') : t('admin.role.save')}
              </Button>
              <Button
                className="react-aria-Button tcp-button--outline"
                onPress={onClose}
              >
                {t('admin.role.cancel')}
              </Button>
            </ButtonRow>
          </form>
        </TabPanel>
        <TabPanel id="knowledge" className="react-aria-TabPanel">
          {saved !== null && (
            <KnowledgePanel
              scope={{ kind: 'role', roleId: saved.id }}
              headingLevel={3}
            />
          )}
        </TabPanel>
      </Tabs>
    </Dialog>
  );
};
