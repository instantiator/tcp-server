import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { t } from '../../../../strings';
import { expectNoA11yViolations } from '../../../../test-support/axe';
import {
  installFetchMock,
  requestedUrls,
  respondByRoute,
} from '../../../../test-support/fetch-mock';
import { ResourcesDetails } from './ResourcesDetails';

const COMPANY_ID = 'company-1';

const company = {
  id: COMPANY_ID,
  slug: 'acme-co',
  name: 'Acme Co',
  description: 'A company',
  mcpServerList: [],
  nextTaskShortcodeIndex: 1,
};

/** A `resources/` listing with these subfolders, and a file the tray hides. */
const resources = (
  folders: readonly (readonly [string, string | null])[] = [
    ['pricing', 'Price lists'],
    ['policies', null],
  ],
) => ({
  path: 'resources/',
  writable: true,
  folders: folders.map(([name, purpose]) => ({
    path: `resources/${name}/`,
    name,
    purpose,
  })),
  files: [
    {
      path: 'resources/README.md',
      name: 'README.md',
      size: 10,
      lastModified: '2026-11-01T09:00:00Z',
    },
  ],
});

/** Answers the company and every folder listing; `listing` answers `resources/`. */
const respond = (listing = resources()): void => {
  respondByRoute([
    [/\/api\/company\/company-1(\?|$)/, { body: company }],
    [/storage\/folder\?path=resources%2F$/, { body: listing }],
    [
      /storage\/folder\?path=resources%2F.+/,
      { body: { path: '', writable: true, folders: [], files: [] } },
    ],
  ]);
};

const renderTray = (portalContainer?: Element) =>
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      {/* The tray always sits in VisualisationTray's <aside>. */}
      <aside aria-label="Tray">
        <ResourcesDetails
          companyId={COMPANY_ID}
          headingId="resources-heading"
          portalContainer={portalContainer}
        />
      </aside>
    </QueryClientProvider>,
  );

const folderRow = (name: RegExp) => screen.findByRole('row', { name });

const listings = () =>
  requestedUrls().filter((url) =>
    url.includes('storage/folder?path=resources%2F'),
  ).length;

describe('ResourcesDetails', () => {
  beforeEach(() => {
    installFetchMock();
  });

  afterEach(() => {
    window.__TCP_CONFIG__ = {
      oidcIssuerUrl: 'https://idp.example.com',
      oidcClientId: 'tcp-web-test',
    };
  });

  it('lists the resource folders with their purposes, and no files', async () => {
    respond();
    renderTray();
    expect(await folderRow(/^pricing, Price lists$/)).toBeInTheDocument();
    expect(await folderRow(/^policies$/)).toBeInTheDocument();
    expect(screen.queryByRole('row', { name: /README/ })).toBeNull();
    expect(
      screen.getByRole('treegrid', {
        name: t('visualisation.resources.heading'),
      }),
    ).toBeInTheDocument();
  });

  it('opens a folder from the keyboard in a dialog inside the portal container, with its purpose, returning focus to the row', async () => {
    respond();
    const container = document.body.appendChild(document.createElement('div'));
    const user = userEvent.setup();
    renderTray(container);

    const pricing = await folderRow(/^pricing/);
    pricing.focus();
    await user.keyboard('{Enter}');

    const dialog = await screen.findByRole('dialog', { name: 'pricing' });
    expect(container).toContainElement(dialog);
    expect(dialog).toHaveTextContent('Price lists');
    await waitFor(() => {
      expect(
        requestedUrls().some((url) =>
          url.includes('path=resources%2Fpricing%2F'),
        ),
      ).toBe(true);
    });
    await expectNoA11yViolations(document.body);

    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    await waitFor(() => {
      expect(pricing).toHaveFocus();
    });
    container.remove();
  });

  it('opens a folder on a click too', async () => {
    respond();
    const user = userEvent.setup();
    renderTray();
    await user.click(await folderRow(/^policies/));
    expect(
      await screen.findByRole('dialog', { name: 'policies' }),
    ).toBeInTheDocument();
  });

  it('browses all resources, files included, from the tray action', async () => {
    respond();
    const user = userEvent.setup();
    renderTray();
    await folderRow(/^pricing/);
    await user.click(
      screen.getByRole('button', {
        name: t('visualisation.resources.browseAll'),
      }),
    );
    const dialog = await screen.findByRole('dialog', {
      name: t('visualisation.resources.heading'),
    });
    expect(
      await screen.findByRole('row', { name: /README\.md/ }),
    ).toBeInTheDocument();
    expect(dialog).toBeInTheDocument();
  });

  it('links to the resources folder in the storage console only when configured', async () => {
    respond();
    const first = renderTray();
    await folderRow(/^pricing/);
    expect(screen.queryByRole('link')).toBeNull();
    first.unmount();

    window.__TCP_CONFIG__ = {
      oidcIssuerUrl: 'https://idp.example.com',
      oidcClientId: 'tcp-web-test',
      storageConsoleUrl: 'http://localhost:9001',
      storageBucket: 'tcp',
    };
    renderTray();
    const link = await screen.findByRole('link', {
      name: `${t('visualisation.resources.consoleLink')} ${t('visualisation.resources.consoleLinkSuffix')}`,
    });
    expect(link).toHaveAttribute(
      'href',
      'http://localhost:9001/browser/tcp/acme-co%2Fresources%2F',
    );
  });

  it('says so when there are no resource folders yet', async () => {
    respond(resources([]));
    renderTray();
    expect(
      await screen.findByRole('heading', {
        name: t('visualisation.resources.empty.heading'),
      }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('treegrid')).toBeNull();
  });

  it('fetches the folders again on refresh', async () => {
    respond();
    const user = userEvent.setup();
    renderTray();
    await folderRow(/^pricing/);
    const before = listings();
    await user.click(
      screen.getByRole('button', {
        name: t('visualisation.resources.refresh'),
      }),
    );
    await waitFor(() => {
      expect(listings()).toBeGreaterThan(before);
    });
  });

  it('has no accessibility violations', async () => {
    respond();
    const { container } = renderTray();
    await folderRow(/^pricing/);
    await expectNoA11yViolations(container);
  });
});
