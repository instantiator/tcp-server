import { Bot, ListTodo, MessageCircleQuestion } from 'lucide-react';
import { Link } from 'react-router';
import { useLoadingAnnouncement } from '../../announce/useLoadingAnnouncement';
import { ApiError } from '../../api/errors';
import { useCompanies } from '../../api/hooks';
import { ACTIVE_TASK_STATUSES } from '../../api/statuses';
import { EmptyState } from '../../components/EmptyState/EmptyState';
import { ErrorState } from '../../components/ErrorState/ErrorState';
import { Icon } from '../../components/Icon/Icon';
import { LoadingState } from '../../components/LoadingState/LoadingState';
import { useDocumentTitle } from '../../shell/useDocumentTitle';
import { t, tCount } from '../../strings';
import './CompaniesPage.css';

/**
 * The companies overview: every company the signed-in user belongs to, with
 * enough of each one's state to decide where to look next.
 *
 * Calls `useCompanies()` with no filter. `?all=true` is administrator-only
 * (002.05) and 403s for anyone else, so this page only ever asks for "mine".
 *
 * The `h1` is the route-change focus target, so it stays the page's only
 * level-1 heading however the list below it grows.
 */
export const CompaniesPage = () => {
  useDocumentTitle(t('page.companies.title'));
  const { data, isPending, error, refetch } = useCompanies();

  useLoadingAnnouncement(
    isPending,
    error === null
      ? { channel: 'companies', change: 'announce.companiesLoaded' }
      : null,
  );

  // A 403 here is a refusal, not an empty state: the user is being told no,
  // not told there is nothing. Folding it into `EmptyState` would read as
  // "you have no companies" when the truth is "you are not allowed to ask".
  const message =
    error instanceof ApiError && error.status === 403
      ? t('companies.error.forbidden')
      : t('companies.error.failed');

  return (
    <>
      <h1>{t('page.companies.title')}</h1>
      {/*
        ADR-027 marks the region whose content is loading as busy.
        `LoadingState` deliberately does not, because it does not know how
        much of the page it stands in for — this element does.
      */}
      <div className="companies-page__list" aria-busy={isPending}>
        {isPending && <LoadingState label={t('companies.loading')} />}

        {!isPending && error !== null && (
          <ErrorState
            message={message}
            channel="companies"
            onRetry={() => {
              void refetch();
            }}
          />
        )}

        {!isPending && error === null && data.length === 0 && (
          // Passed explicitly rather than accepted as the default: the page
          // owns its outline, and this sits directly under the single `h1`,
          // so `2` records that decision instead of inheriting it.
          <EmptyState heading={t('companies.empty.heading')} headingLevel={2}>
            <p>{t('companies.empty.body')}</p>
          </EmptyState>
        )}

        {!isPending && error === null && data.length > 0 && (
          <ul className="companies-page__companies">
            {data.map((company) => {
              // `tasksByStatus` is zero-filled by the server (002.04), so a
              // missing key is a bug rather than an absent count — read it
              // directly and let a `NaN` show rather than defaulting it away.
              const activeTasks = ACTIVE_TASK_STATUSES.reduce(
                (sum, status) => sum + company.stats.tasksByStatus[status],
                0,
              );
              return (
                <li
                  className="companies-page__company tcp-card"
                  key={company.id}
                >
                  {/*
                    `tcp-card__link` stretches over the whole card (its
                    `::after` covers the card's full area), so the whole card
                    is clickable even though only the name is a link.
                  */}
                  <Link
                    className="tcp-card__link"
                    to={`/company/${company.id}`}
                  >
                    {company.name}
                  </Link>
                  <ul className="companies-page__stats">
                    <li>
                      <Icon icon={Bot} />
                      {tCount(
                        'companies.count.activeAgents',
                        company.stats.activeAgents,
                      )}
                    </li>
                    <li>
                      <Icon icon={ListTodo} />
                      {tCount('companies.count.activeTasks', activeTasks)}
                    </li>
                    <li>
                      <Icon icon={MessageCircleQuestion} />
                      {tCount(
                        'companies.count.openEnquiries',
                        company.stats.openEnquiries,
                      )}
                    </li>
                  </ul>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </>
  );
};
