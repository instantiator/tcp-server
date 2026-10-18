import { Bot, ListTodo, MessageCircleQuestion } from 'lucide-react';
import { useState } from 'react';
import { Button, ToggleButton, ToggleButtonGroup } from 'react-aria-components';
import { Link, useSearchParams } from 'react-router';
import { useLoadingAnnouncement } from '../../announce/useLoadingAnnouncement';
import { ApiError } from '../../api/errors';
import { useCompanies, useSystemStatus } from '../../api/hooks';
import { ACTIVE_TASK_STATUSES } from '../../api/statuses';
import { EmptyState } from '../../components/EmptyState/EmptyState';
import { ErrorState } from '../../components/ErrorState/ErrorState';
import { Icon } from '../../components/Icon/Icon';
import { LoadingState } from '../../components/LoadingState/LoadingState';
import { useDocumentTitle } from '../../shell/useDocumentTitle';
import { t, tCount } from '../../strings';
import { CreateCompanyDialog } from './CreateCompanyDialog';
import {
  TemplateGalleryDialog,
  type ChosenTemplate,
} from './TemplateGalleryDialog';
import './CompaniesPage.css';

/**
 * The companies overview: the companies the signed-in user can see, with
 * enough of each one's state to decide where to look next.
 *
 * Shows the caller's own companies by default. Administrators also get a
 * toggle for every company (`?all=true`, kept in the URL as `?scope=all`);
 * the server 403s anyone else, so nobody else is offered it or sends it.
 *
 * The `h1` is the route-change focus target, so it stays the page's only
 * level-1 heading however the list below it grows.
 */
export const CompaniesPage = () => {
  useDocumentTitle(t('page.companies.title'));
  const isAdmin = useSystemStatus().data?.admin === true;
  const [params, setParams] = useSearchParams();
  // ponytail: a cold load of ?scope=all may fetch "mine" first and "all" once
  // the admin flag arrives; gate the fetch only if the flash is noticed.
  const showAll = isAdmin && params.get('scope') === 'all';
  const { data, isPending, error, refetch } = useCompanies(
    showAll ? { all: true } : {},
  );
  // New company is two steps and one dialog at a time: the gallery, then the
  // form it leads to, blank or from the chosen template.
  const [step, setStep] = useState<
    | { readonly kind: 'closed' }
    | { readonly kind: 'gallery' }
    | { readonly kind: 'scratch' }
    | { readonly kind: 'template'; readonly template: ChosenTemplate }
  >({ kind: 'closed' });
  const close = () => setStep({ kind: 'closed' });
  const newCompany = (
    <Button
      className="react-aria-Button"
      onPress={() => setStep({ kind: 'gallery' })}
    >
      {t('companies.create.open')}
    </Button>
  );

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
      : t(showAll ? 'companies.error.failedAll' : 'companies.error.failed');

  return (
    <>
      <h1>{t('page.companies.title')}</h1>
      <div className="companies-page__toolbar">
        {newCompany}
        {isAdmin && (
          <ToggleButtonGroup
            selectionMode="single"
            disallowEmptySelection
            aria-label={t('companies.scope.label')}
            selectedKeys={[showAll ? 'all' : 'mine']}
            onSelectionChange={(keys) => {
              // Mine is the default, so it leaves the URL bare.
              setParams(keys.has('all') ? { scope: 'all' } : {}, {
                replace: true,
              });
            }}
          >
            <ToggleButton id="mine" className="react-aria-ToggleButton">
              {t('companies.scope.mine')}
            </ToggleButton>
            <ToggleButton id="all" className="react-aria-ToggleButton">
              {t('companies.scope.all')}
            </ToggleButton>
          </ToggleButtonGroup>
        )}
      </div>
      <TemplateGalleryDialog
        isOpen={step.kind === 'gallery'}
        onClose={close}
        onScratch={() => setStep({ kind: 'scratch' })}
        onChosen={(template) => setStep({ kind: 'template', template })}
      />
      <CreateCompanyDialog
        isOpen={step.kind === 'scratch' || step.kind === 'template'}
        onClose={close}
        template={step.kind === 'template' ? step.template : undefined}
      />
      {/*
        ADR-027 marks the region whose content is loading as busy.
        `LoadingState` deliberately does not, because it does not know how
        much of the page it stands in for — this element does.
      */}
      <div className="companies-page__list" aria-busy={isPending}>
        {isPending && (
          <LoadingState
            label={t(showAll ? 'companies.loadingAll' : 'companies.loading')}
          />
        )}

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
          <EmptyState
            heading={t(
              showAll
                ? 'companies.empty.headingAll'
                : 'companies.empty.heading',
            )}
            headingLevel={2}
          >
            <p>
              {t(showAll ? 'companies.empty.bodyAll' : 'companies.empty.body')}
            </p>
            {newCompany}
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
                  {showAll && company.memberType === null && (
                    <p className="companies-page__not-member">
                      {t('companies.notMember')}
                    </p>
                  )}
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
