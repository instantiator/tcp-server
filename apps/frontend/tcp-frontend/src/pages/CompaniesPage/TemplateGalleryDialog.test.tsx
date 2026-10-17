import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CompanyTemplatePreview } from '../../api/dtos';
import { t } from '../../strings';
import { expectNoA11yViolations } from '../../test-support/axe';
import {
  fetchMock,
  installFetchMock,
  respondByRoute,
} from '../../test-support/fetch-mock';
import { TemplateGalleryDialog } from './TemplateGalleryDialog';

const PREVIEW: CompanyTemplatePreview = {
  formatVersion: 1,
  company: {
    slug: 'basic',
    name: 'Basic',
    description: 'A planner.',
    timezone: null,
    companyContext: null,
    llmConfig: null,
    embeddingConfig: null,
  },
  plannerRole: 'planner',
  roles: [],
  documents: [],
  neededKeys: [],
  slugTaken: false,
  warnings: [],
};

const gallery = [
  {
    sourceId: 'builtin',
    sourceName: 'Built in',
    name: 'basic',
    title: 'Basic',
    description: 'A planner.',
    roles: 1,
    documents: 0,
  },
  {
    sourceId: 'builtin',
    sourceName: 'Built in',
    name: 'blank',
    title: 'Blank',
    description: 'Nothing yet.',
    roles: 0,
    documents: 3,
  },
  {
    sourceId: 'community',
    sourceName: 'Community',
    name: 'cottage',
    title: 'Cottage industry',
    description: 'Sells crafts.',
    roles: 4,
    documents: 1,
  },
];

const routes = [
  [/\/api\/template$/, { body: gallery }],
  [/\/api\/company\/import\/preview$/, { body: PREVIEW }],
] as const;

const onClose = vi.fn();
const onScratch = vi.fn();
const onChosen = vi.fn();

const renderGallery = () =>
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <TemplateGalleryDialog
        isOpen
        onClose={onClose}
        onScratch={onScratch}
        onChosen={onChosen}
      />
    </QueryClientProvider>,
  );

/** The multipart fields of the preview request made so far. */
const previewFields = (): FormData => {
  const call = fetchMock.mock.calls.find(([input]) =>
    (input instanceof Request ? input.url : String(input)).endsWith('/preview'),
  );
  if (!(call?.[1]?.body instanceof FormData))
    throw new Error('no preview request');
  return call[1].body;
};

describe('TemplateGalleryDialog', () => {
  beforeEach(() => {
    installFetchMock();
    respondByRoute([...routes]);
    onClose.mockClear();
    onScratch.mockClear();
    onChosen.mockClear();
  });

  it('lists templates under a heading per source, with counts', async () => {
    renderGallery();

    const builtIn = await screen.findByRole('heading', { name: 'Built in' });
    const community = screen.getByRole('heading', { name: 'Community' });
    expect(builtIn.compareDocumentPosition(community)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    const items = screen.getAllByRole('listitem');
    const blank = items.find((item) => within(item).queryByText('Blank'));
    expect(blank).toHaveTextContent('0 roles · 3 documents');
    const basic = items.find((item) => within(item).queryByText('Basic'));
    expect(basic).toHaveTextContent('1 role · 0 documents');
    expect(
      screen.getByRole('button', {
        name: t('companies.gallery.useNamed', { title: 'Cottage industry' }),
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', {
        name: t('companies.gallery.downloadNamed', { title: 'Blank' }),
      }),
    ).toBeInTheDocument();
  });

  it('starts from scratch', async () => {
    const user = userEvent.setup();
    renderGallery();
    await user.click(
      await screen.findByRole('button', {
        name: t('companies.gallery.scratch'),
      }),
    );
    expect(onScratch).toHaveBeenCalled();
  });

  it('previews a chosen template by its source and name', async () => {
    const user = userEvent.setup();
    renderGallery();
    await user.click(
      await screen.findByRole('button', {
        name: t('companies.gallery.useNamed', { title: 'Cottage industry' }),
      }),
    );

    await waitFor(() =>
      expect(onChosen).toHaveBeenCalledWith({
        preview: PREVIEW,
        source: 'community/cottage',
      }),
    );
    expect(previewFields().get('template')).toBe('community/cottage');
  });

  it('previews a chosen zip file', async () => {
    const user = userEvent.setup();
    renderGallery();
    const file = new File(['zip'], 'mine.zip', { type: 'application/zip' });
    await user.upload(
      await screen.findByLabelText(t('companies.gallery.importFile')),
      file,
    );

    await waitFor(() =>
      expect(onChosen).toHaveBeenCalledWith({ preview: PREVIEW, source: file }),
    );
    expect(previewFields().get('file')).toBeInstanceOf(File);
  });

  it('shows the server’s message when a template has problems', async () => {
    const user = userEvent.setup();
    respondByRoute([
      routes[0],
      [
        /\/preview$/,
        { status: 400, body: { message: 'company.json is missing' } },
      ],
    ]);
    renderGallery();
    await user.click(
      await screen.findByRole('button', {
        name: t('companies.gallery.useNamed', { title: 'Blank' }),
      }),
    );

    expect(await screen.findByText('company.json is missing')).toBeVisible();
    expect(onChosen).not.toHaveBeenCalled();
  });

  it('says so when a template cannot be read for any other reason', async () => {
    const user = userEvent.setup();
    respondByRoute([
      routes[0],
      [/\/preview$/, { status: 500, body: { message: 'boom' } }],
    ]);
    renderGallery();
    await user.click(
      await screen.findByRole('button', {
        name: t('companies.gallery.useNamed', { title: 'Blank' }),
      }),
    );

    expect(await screen.findByText(t('records.error.generic'))).toBeVisible();
  });

  it('lists the sources that could not be read', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify(gallery), {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'X-Tcp-Warnings': JSON.stringify([
              encodeURIComponent('Source “Mine” is unreadable'),
            ]),
          },
        }),
      ),
    );
    renderGallery();

    expect(
      await screen.findByText('Source “Mine” is unreadable'),
    ).toBeInTheDocument();
  });

  it('says when there are no templates', async () => {
    respondByRoute([[/\/api\/template$/, { body: [] }]]);
    renderGallery();
    expect(
      await screen.findByText(t('companies.gallery.empty')),
    ).toBeInTheDocument();
  });

  it('offers a retry when the gallery cannot be loaded', async () => {
    respondByRoute([[/\/api\/template$/, { status: 500, body: {} }]]);
    renderGallery();
    expect(
      await screen.findByRole('button', { name: t('state.error.retry') }),
    ).toBeInTheDocument();
  });

  it('has no accessibility violations', async () => {
    renderGallery();
    await screen.findByRole('heading', { name: 'Built in' });
    await expectNoA11yViolations(document.body);
  });
});
