import { useLayoutEffect } from 'react';

/**
 * Sets the document title for the page currently rendered.
 *
 * The title lives with the page rather than in the route table because
 * `/company/:companyId` is titled by the company's name — loaded data, which no
 * static table can hold (006.01).
 *
 * This is half of the route announcement: `useRouteChange` reads
 * `document.title` back on navigation, and React flushes child effects before
 * parent ones, so it is guaranteed to read the page that has just rendered
 * rather than the one before it. A page that forgets to call this announces its
 * predecessor's name — which is what the per-page title assertions exist to
 * catch.
 */
export const useDocumentTitle = (title: string): void => {
  useLayoutEffect(() => {
    document.title = title;
  }, [title]);
};
