import { Link } from 'react-router';
import { useDocumentTitle } from '../../shell/useDocumentTitle';
import { t } from '../../strings';

/**
 * The rendering half of the catch-all carried forward from 002.03.
 *
 * nginx returns the app document with a 200 for any unknown path, and always
 * will — a static server cannot know which paths the router knows, so the
 * status code is not a defect to fix here. Before this page existed, an
 * unknown address rendered a blank screen.
 */
export const NotFoundPage = () => {
  useDocumentTitle(t('page.notFound.title'));

  return (
    <>
      <h1>{t('page.notFound.title')}</h1>
      <p>{t('page.notFound.body')}</p>
      <Link to="/">{t('page.notFound.home')}</Link>
    </>
  );
};
