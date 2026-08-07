import { useParams } from 'react-router';
import { streamUrls } from '../../events/subscriptions';
import { useEventStream } from '../../events/useEventStream';
import { useDocumentTitle } from '../../shell/useDocumentTitle';
import { t } from '../../strings';

/**
 * A placeholder for 006.01, whose real version titles the page with the
 * company's name rather than a fixed string — which is exactly why
 * `useDocumentTitle` takes a value rather than a route-table key.
 */
export const CompanyPage = () => {
  const { companyId } = useParams();
  useDocumentTitle(t('page.company.title'));

  // ponytail: the error is unrendered until 006.01, which owns this page's
  // real layout and its error states.
  useEventStream(companyId ? streamUrls.company(companyId) : null);

  return (
    <>
      <h1>{t('page.company.title')}</h1>
      <p>{companyId ?? ''}</p>
    </>
  );
};
