import { Tab, TabList, TabPanel, Tabs } from 'react-aria-components';
import { Link, useParams } from 'react-router';
import { useLoadingAnnouncement } from '../../announce/useLoadingAnnouncement';
import { useCompany } from '../../api/queries';
import { Breadcrumbs } from '../../components/Breadcrumbs/Breadcrumbs';
import { EmptyState } from '../../components/EmptyState/EmptyState';
import { ErrorState } from '../../components/ErrorState/ErrorState';
import { LoadingState } from '../../components/LoadingState/LoadingState';
import { streamUrls } from '../../events/subscriptions';
import { useEventStream } from '../../events/useEventStream';
import { useDocumentTitle } from '../../shell/useDocumentTitle';
import { t } from '../../strings';
import './CompanyPage.css';

/**
 * The frame every company view sits inside: where you are, the way back up,
 * and the tabs the views themselves are reached through.
 *
 * **The tab list has one tab, deliberately** ([ADR-020](../../../../../docs/ADRs/ADR-020-web-ui-mvp-scope.md)).
 * This looks like over-building and is the opposite. The alternative is a
 * single-view layout that has to be dismantled and rebuilt as tabs when the
 * configuration view lands (010.01) — in a release that also has to get that
 * view right. The tab component is small; the retrofit is not, and it would be
 * paid at the worst moment. Do not "simplify" this into a bare panel.
 *
 * **React Aria's `RouterProvider` is not adopted, and that is a decision rather
 * than an omission** (003.02 asked for it to be taken here). `Tabs` renders
 * `role="tab"` buttons, not links, so nothing on this page brings React Aria's
 * own `Link` into the application; the breadcrumb and the company rows both use
 * react-router's. One link mechanism, and no router-wide integration adopted to
 * serve a component that does not need it.
 */
export const CompanyPage = () => {
  const { companyId } = useParams();
  const { data, isPending, error, refetch } = useCompany(companyId ?? '');

  // `GET /api/company/{id}` answers **200 with a JSON `null`** for a company
  // the caller cannot see, so "no such company" arrives as a successful
  // response rather than as an error. The generated types do not say so — they
  // describe the body as a company — which is why this collapses `null` into
  // the same `undefined` that a request still in flight produces, rather than
  // trusting the declared type and reading `.name` off nothing.
  const company = data ?? undefined;

  // `useDocumentTitle` runs in a layout effect, so on a cache hit the title is
  // already the company's name by the time `useRouteChange` reads it back. On a
  // cold load the route change announces "Company" and the completion
  // announcement below then names the company. That sequence is intended: the
  // alternative is holding the route announcement until data arrives, which
  // leaves a screen reader user with no idea they navigated at all.
  useDocumentTitle(company?.name ?? t('page.company.title'));

  const { error: streamError } = useEventStream(
    companyId === undefined ? null : streamUrls.company(companyId),
  );

  // `null` on any path that did not end with a company: a failed load already
  // announces itself through `ErrorState`, and "undefined loaded" is not a
  // sentence.
  useLoadingAnnouncement(
    isPending,
    company === undefined
      ? null
      : {
          channel: 'company',
          change: 'announce.companyLoaded',
          params: { name: company.name },
        },
  );

  return (
    <>
      {/* The last crumb omits `to`, which is what marks it `aria-current="page"`. */}
      <Breadcrumbs
        items={[
          { label: t('page.companies.title'), to: '/companies' },
          { label: company?.name ?? t('page.company.title') },
        ]}
      />
      <h1>{company?.name ?? t('page.company.title')}</h1>

      {/*
        Outside the busy region on purpose. A dead live connection is not a page
        that failed to load: the company is on screen and still readable, it has
        simply stopped updating. Putting this inside would let the spinner
        replace the one message explaining why nothing is moving.
      */}
      {streamError !== null && (
        <ErrorState
          message={t('company.stream.failed')}
          channel="company-stream"
        />
      )}

      {/*
        ADR-027 marks the region whose content is loading as busy.
        `LoadingState` deliberately does not — it cannot know how much of the
        page it stands in for, and this element does.
      */}
      <div className="company-page__body" aria-busy={isPending}>
        {isPending && <LoadingState label={t('company.loading')} />}

        {!isPending && error !== null && (
          <ErrorState
            message={t('company.error.failed')}
            channel="company"
            onRetry={() => {
              void refetch();
            }}
          />
        )}

        {!isPending && error === null && company === undefined && (
          <EmptyState
            heading={t('company.unavailable.heading')}
            headingLevel={2}
          >
            <p>{t('company.unavailable.body')}</p>
            <Link to="/companies">{t('company.unavailable.back')}</Link>
          </EmptyState>
        )}

        {!isPending && error === null && company !== undefined && (
          <Tabs className="react-aria-Tabs company-page__tabs">
            {/*
              Every `className` here repeats React Aria's own default class
              name, because passing `className` *replaces* the default rather
              than composing with it — the trap `ThemeControl` and `Header`
              both carry a note about. Drop the prefix and every rule in
              `base.css` stops applying, with nothing in jsdom to notice.
            */}
            <TabList
              aria-label={t('company.tabs.label')}
              className="react-aria-TabList"
            >
              <Tab id="activity" className="react-aria-Tab">
                {t('company.tab.activity')}
              </Tab>
            </TabList>
            {/* 007.01 renders the live activity view into this panel. */}
            <TabPanel id="activity" className="react-aria-TabPanel" />
          </Tabs>
        )}
      </div>
    </>
  );
};
