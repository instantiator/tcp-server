import { Link } from 'react-router';
import { useCompanies } from '../../api/hooks';
import { Dialog } from '../Dialog/Dialog';
import { EmptyState } from '../EmptyState/EmptyState';
import { ErrorState } from '../ErrorState/ErrorState';
import { LoadingState } from '../LoadingState/LoadingState';
import { t } from '../../strings';
import './MembershipsDialog.css';

export interface MembershipsDialogProps {
  readonly onClose: () => void;
}

/**
 * The companies the signed-in user can reach, each a link to open it.
 *
 * `useCompanies({})` — the membership-scoped `GET /api/company`, with no
 * `?all=true` — is the exact call `CompaniesPage` makes, so this reads the
 * query cache `CompaniesPage` already filled rather than firing a second
 * request. `useNavigate` is not used anywhere in this codebase and is not
 * introduced here either; a plain `<Link>`, matching `CompaniesPage.tsx`, is
 * both the router's own navigation and something every assistive technology
 * already understands.
 */
export const MembershipsDialog = ({ onClose }: MembershipsDialogProps) => {
  const { data, isPending, isError } = useCompanies({});

  return (
    <Dialog
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      heading={t('memberships.heading')}
    >
      {isPending && <LoadingState label={t('memberships.loading')} />}

      {isError && (
        <ErrorState message={t('memberships.error')} channel="memberships" />
      )}

      {!isPending &&
        !isError &&
        data !== undefined &&
        (data.length === 0 ? (
          <EmptyState heading={t('memberships.empty.heading')} headingLevel={3}>
            <p>{t('memberships.empty.body')}</p>
          </EmptyState>
        ) : (
          <>
            <p className="memberships-dialog__intro">
              {t('memberships.intro')}
            </p>
            {/*
              Authoritative, not informational (002.05): this is the list of
              companies the user CAN REACH. Anything absent from it answers
              403, not "not listed here" — do not soften this wording back to
              "companies you are listed in".
            */}
            <ul className="memberships-dialog__companies">
              {data.map((company) => (
                <li key={company.id} className="memberships-dialog__company">
                  <Link
                    to={`/company/${company.id}`}
                    // Closing on click, rather than closing only after the
                    // navigation resolves: the dialog then unmounts, and React
                    // Aria's `ModalOverlay` returns focus to whatever opened
                    // it — the account button in `Header.tsx`, which is in the
                    // header and survives the navigation. That is a deliberate,
                    // present destination for focus, not `document.body`.
                    onClick={onClose}
                  >
                    {company.name}
                  </Link>
                </li>
              ))}
            </ul>
          </>
        ))}
    </Dialog>
  );
};
