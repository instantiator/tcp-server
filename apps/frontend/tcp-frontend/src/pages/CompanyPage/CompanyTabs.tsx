import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Tab, TabList, TabPanel, Tabs, type Key } from 'react-aria-components';
import { useLocation, useNavigate } from 'react-router';
import { useCompanyRolesList } from '../../api/hooks';
import { t, type StringKey } from '../../strings';
import { AgentsList } from './activity/AgentsList';
import type { CountListener } from './activity/activity-list-utils';
import { ChatsList } from './activity/ChatsList';
import { ConsultationsList } from './activity/ConsultationsList';
import { EnquiriesList } from './activity/EnquiriesList';
import { NewEnquiryNotifications } from './activity/NewEnquiryNotifications';
import { NewNotificationToasts } from './activity/NewNotificationToasts';
import { NotificationsList } from './activity/NotificationsList';
import { TasksList } from './activity/TasksList';
import { AdminPanel } from './AdminPanel';
import { isAdminSection } from './admin-sections';
import { DataPanel, type DataSelection } from './DataPanel';
import './activity/activity.css';

/** The activity lists, one tab each, in tab order. Each id is also its URL hash. */
const ACTIVITY_TABS = [
  { id: 'agents', label: 'activity.agents.heading' },
  { id: 'tasks', label: 'activity.tasks.heading' },
  { id: 'consultations', label: 'activity.consultations.heading' },
  { id: 'enquiries', label: 'activity.enquiries.heading' },
  { id: 'chats', label: 'activity.chats.heading' },
  { id: 'notifications', label: 'notifications.heading' },
] as const satisfies readonly { id: string; label: StringKey }[];

type ActivityTab = (typeof ACTIVITY_TABS)[number]['id'];

/** The tab shown with no hash, or an unknown one. */
const DEFAULT_TAB = 'visualisation';

/** Record tables and document links (002.00). Its hash names the section: `#data/tables/orders`, `#data/documents`. */
const DATA_TAB = 'data';

/** Roles, users, knowledge and data protection (002.00). Its hash names the section: `#admin/users`. */
const ADMIN_TAB = 'admin';

/**
 * Hashes from before 002.00 and where they went, so a bookmark or a sign-in
 * return still lands in the right place: `#tables/orders` → `#data/tables/orders`,
 * `#data-protection` → `#admin/data-protection`.
 */
const movedHash = (path: string): string | null => {
  const [key] = path.split('/');
  if (key === 'tables') return `#${DATA_TAB}/${path}`;
  if (key === 'data-protection') return `#${ADMIN_TAB}/${path}`;
  return null;
};

/** The Data tab's section, from the hash path after `data/`. */
const dataSelection = ([section, table]: string[]): DataSelection =>
  section === 'documents'
    ? { kind: 'documents' }
    : {
        kind: 'tables',
        table: section === 'tables' && table ? decodeURIComponent(table) : null,
      };

const isActivityTab = (key: string): key is ActivityTab =>
  ACTIVITY_TABS.some((tab) => tab.id === key);

export interface CompanyTabsProps {
  readonly companyId: string;
  /** For the names of downloaded files. */
  readonly companySlug: string;
  /** The office view, shown in the first tab. */
  readonly visualisation: ReactNode;
}

/**
 * The company's tabs: the office view, then one tab per live activity list,
 * each tab titled with its list's name and a badge of how many rows it shows,
 * then Data (record tables and document links) and Admin (roles, users,
 * knowledge and data protection), each a side menu whose section is in the
 * hash too (`#data/tables/orders`, `#admin/users`).
 *
 * **The selected tab is the URL hash** (`#tasks`, `#enquiries`, …), so a
 * notification's link to `#enquiries` opens that tab, and every tab can be
 * linked to. Selecting a tab replaces the history entry rather than pushing
 * one: switching tabs is not navigating, and Back should leave the company.
 * `useRouteChange` watches only the pathname, so a hash change moves no focus.
 *
 * **Activity panels stay mounted while hidden** (`shouldForceMount`). That is
 * what keeps a list's filters when the user switches away and back, with no
 * filter state lifted out of the lists, and what keeps every badge current.
 * React Aria makes a hidden panel `inert`; `base.css` hides it. The office
 * view's panel is not force-mounted: a hidden canvas has no size to draw at.
 *
 * **This opens no event stream of its own.** `CompanyPage` already subscribes
 * to `streamUrls.company(companyId)`, and every event patches the TanStack
 * Query cache these lists read (ADR-025) — so the lists stay live without a
 * second subscription, and `MAX_STREAMS` is untouched.
 *
 * Role names are fetched once here, rather than once per list, because five
 * lists each fetching the same company's roles would be five identical
 * requests for the same answer.
 *
 * Every `className` repeats React Aria's own default class name, because
 * passing `className` *replaces* the default rather than composing with it.
 */
export const CompanyTabs = ({
  companyId,
  companySlug,
  visualisation,
}: CompanyTabsProps) => {
  const { data: roles } = useCompanyRolesList(companyId);
  const roleNames = useMemo(
    () => new Map((roles ?? []).map((role) => [role.id, role.name])),
    [roles],
  );

  const { hash } = useLocation();
  const navigate = useNavigate();
  // An old hash is read as its new one at once, so the right tab mounts
  // first time, and then rewritten in the address.
  const moved = movedHash(hash.slice(1));
  useEffect(() => {
    if (moved !== null) void navigate({ hash: moved }, { replace: true });
  }, [moved, navigate]);
  const [hashKey, ...hashRest] = (moved ?? hash).slice(1).split('/');
  const selectedKey =
    isActivityTab(hashKey) || hashKey === DATA_TAB || hashKey === ADMIN_TAB
      ? hashKey
      : DEFAULT_TAB;
  const [adminHash = ''] = hashRest;
  const adminSection = isAdminSection(adminHash) ? adminHash : 'company';
  const replaceHash = (next: string): void => {
    void navigate({ hash: next }, { replace: true });
  };
  const onSelectionChange = (key: Key): void => {
    replaceHash(key === DEFAULT_TAB ? '' : `#${String(key)}`);
  };
  const onDataSelect = (selection: DataSelection): void => {
    replaceHash(
      selection.kind === 'documents'
        ? `#${DATA_TAB}/documents`
        : selection.table === null
          ? `#${DATA_TAB}`
          : `#${DATA_TAB}/tables/${encodeURIComponent(selection.table)}`,
    );
  };

  const [counts, setCounts] = useState<
    Partial<Record<ActivityTab, number | null>>
  >({});
  // Stable, because each list reports its count from an effect that depends
  // on the listener.
  const listeners = useMemo(() => {
    const listen =
      (id: ActivityTab): CountListener =>
      (count) => {
        setCounts((current) =>
          current[id] === count ? current : { ...current, [id]: count },
        );
      };
    return {
      agents: listen('agents'),
      tasks: listen('tasks'),
      consultations: listen('consultations'),
      enquiries: listen('enquiries'),
      chats: listen('chats'),
      notifications: listen('notifications'),
    } satisfies Record<ActivityTab, CountListener>;
  }, []);

  const lists: Record<ActivityTab, ReactNode> = {
    agents: (
      <AgentsList
        companyId={companyId}
        roleNames={roleNames}
        onCount={listeners.agents}
      />
    ),
    // No `roleNames`: a task belongs to a company, not to a role.
    tasks: <TasksList companyId={companyId} onCount={listeners.tasks} />,
    consultations: (
      <ConsultationsList
        companyId={companyId}
        roleNames={roleNames}
        onCount={listeners.consultations}
      />
    ),
    enquiries: (
      <EnquiriesList companyId={companyId} onCount={listeners.enquiries} />
    ),
    // `roles`, not just `roleNames`: the chats list's role filter renders one
    // checkbox per role, which needs the roles themselves.
    chats: (
      <ChatsList
        companyId={companyId}
        roleNames={roleNames}
        roles={roles ?? []}
        onCount={listeners.chats}
      />
    ),
    notifications: (
      <NotificationsList
        companyId={companyId}
        onCount={listeners.notifications}
      />
    ),
  };

  return (
    <>
      {/*
        Above the tabs, so a new enquiry is seen from any of them. It reads the
        same enquiries query `EnquiriesList` does, so it costs no extra
        request, and it is the single writer on the `enquiry` announcer
        channel (see the comment in `EnquiriesList`).
      */}
      <NewEnquiryNotifications companyId={companyId} />
      {/*
        Same placement, same reasoning: seen from any tab, and the single
        writer on the `notification` announcer channel. Reads the same
        notifications query `NotificationsList` does, so it costs no extra
        request.
      */}
      <NewNotificationToasts companyId={companyId} />
      <Tabs
        className="react-aria-Tabs company-page__tabs"
        selectedKey={selectedKey}
        onSelectionChange={onSelectionChange}
      >
        <TabList
          aria-label={t('company.tabs.label')}
          className="react-aria-TabList"
        >
          <Tab id={DEFAULT_TAB} className="react-aria-Tab">
            {t('company.tab.visualisation')}
          </Tab>
          {ACTIVITY_TABS.map(({ id, label }) => {
            const count = counts[id];
            return (
              <Tab key={id} id={id} className="react-aria-Tab">
                {t(label)}
                {/* A space, so the tab's name reads "Tasks 3", not "Tasks3". */}
                {typeof count === 'number' && (
                  <>
                    {' '}
                    <span className="tcp-badge">{count}</span>
                  </>
                )}
              </Tab>
            );
          })}
          <Tab id={DATA_TAB} className="react-aria-Tab">
            {t('company.tab.data')}
          </Tab>
          <Tab id={ADMIN_TAB} className="react-aria-Tab">
            {t('company.tab.admin')}
          </Tab>
        </TabList>
        <TabPanel
          id={DEFAULT_TAB}
          className="react-aria-TabPanel company-page__tab"
        >
          {visualisation}
        </TabPanel>
        {ACTIVITY_TABS.map(({ id }) => (
          <TabPanel
            key={id}
            id={id}
            className="react-aria-TabPanel company-page__tab"
            shouldForceMount
          >
            {lists[id]}
          </TabPanel>
        ))}
        {/*
          Not force-mounted: a table's sheet is large and not live, so it
          loads when the tab opens. What is open survives in the URL instead.
        */}
        <TabPanel
          id={DATA_TAB}
          className="react-aria-TabPanel company-page__tab"
        >
          <DataPanel
            companyId={companyId}
            companySlug={companySlug}
            selected={dataSelection(hashRest)}
            onSelect={onDataSelect}
          />
        </TabPanel>
        {/* Not force-mounted, like Data: its sections load when they open. */}
        <TabPanel
          id={ADMIN_TAB}
          className="react-aria-TabPanel company-page__tab"
        >
          <AdminPanel
            companyId={companyId}
            companySlug={companySlug}
            section={adminSection}
            onSelect={(section) => replaceHash(`#${ADMIN_TAB}/${section}`)}
          />
        </TabPanel>
      </Tabs>
    </>
  );
};
