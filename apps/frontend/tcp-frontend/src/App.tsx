import { Route, Routes } from 'react-router';
import { channelForAgent } from './shared-client';
import { t } from './strings';

/**
 * The application's routes. Deliberately a placeholder — the landing page is
 * 003.01 and the real shell (layout, header, navigation) is 003.02.
 *
 * The `channelForAgent` reference keeps the `@tcp/shared/client` import
 * boundary's positive control reachable from the entry point, so the bundler
 * actually resolves it. Remove it once a real screen imports from
 * `@tcp/shared/client`.
 */
const Placeholder = () => (
  <main>
    <h1>{t('app.title')}</h1>
    <p hidden>{channelForAgent('boundary-control')}</p>
  </main>
);

export const App = () => (
  <Routes>
    <Route path="/" element={<Placeholder />} />
  </Routes>
);
