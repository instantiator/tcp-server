import { useDocumentTitle } from '../../shell/useDocumentTitle';
import { t } from '../../strings';

/**
 * Where a user arrives after signing in. A placeholder: the real list, its
 * statistics and its empty state are 006.01.
 *
 * The `h1` is the route-change focus target, so it stays a single level-1
 * heading however the page grows.
 */
export const CompaniesPage = () => {
  useDocumentTitle(t('page.companies.title'));

  return <h1>{t('page.companies.title')}</h1>;
};
