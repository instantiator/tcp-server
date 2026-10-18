import { StrictMode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StorageFileEntryDTO } from '../../api/hooks';
import { t } from '../../strings';
import { fetchMock, installFetchMock } from '../../test-support/fetch-mock';
import { FilePreview } from './FilePreview';
import { MEDIA_PREVIEW_MAX_BYTES, TEXT_PREVIEW_MAX_BYTES } from './previewKind';

const file = (name: string, size = 10): StorageFileEntryDTO => ({
  path: `docs/${name}`,
  name,
  size,
  lastModified: '2026-01-01T00:00:00Z',
});

const renderPreview = (entry: StorageFileEntryDTO) =>
  render(
    <StrictMode>
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <FilePreview companyId="c1" file={entry} />
      </QueryClientProvider>
    </StrictMode>,
  );

const respondWithBody = (body: string): void => {
  fetchMock.mockResolvedValueOnce(new Response(body, { status: 200 }));
};

describe('FilePreview', () => {
  const createObjectURL = vi.fn<(obj: Blob | MediaSource) => string>();
  const revokeObjectURL = vi.fn<(url: string) => void>();

  beforeEach(() => {
    installFetchMock();
    createObjectURL.mockReset().mockReturnValue('blob:preview');
    revokeObjectURL.mockReset();
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = revokeObjectURL;
  });

  it('renders markdown', async () => {
    respondWithBody('# Heading\n\nbody');
    renderPreview(file('a.md'));
    expect(
      await screen.findByRole('heading', { name: 'Heading' }),
    ).toBeInTheDocument();
  });

  it('shows HTML as literal text, never as elements', async () => {
    respondWithBody('<b>x</b>');
    const { container } = renderPreview(file('a.html'));
    expect(await screen.findByText('<b>x</b>')).toBeInTheDocument();
    expect(container.querySelector('b')).toBeNull();
    expect(screen.getByRole('region', { name: 'a.html' })).toHaveAttribute(
      'tabindex',
      '0',
    );
  });

  it('renders CSV as a table with a header row', async () => {
    respondWithBody('name,age\nAda,36');
    renderPreview(file('a.csv'));
    expect(
      await screen.findByRole('columnheader', { name: 'age' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'Ada' })).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'a.csv' })).toBeInTheDocument();
  });

  it('shows an SVG in an img, named by the file', async () => {
    respondWithBody('<svg xmlns="http://www.w3.org/2000/svg"/>');
    renderPreview(file('logo.svg'));
    const img = await screen.findByRole('img', { name: 'logo.svg' });
    expect(img).toHaveAttribute('src', 'blob:preview');
    const blob = createObjectURL.mock.calls[0]?.[0];
    expect(blob).toBeInstanceOf(Blob);
    expect((blob as Blob).type).toBe('image/svg+xml');
  });

  it('revokes the object URL on unmount', async () => {
    respondWithBody('%PDF');
    const { unmount } = renderPreview(file('a.pdf'));
    await screen.findByTitle('a.pdf');
    unmount();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:preview');
  });

  it('does not fetch a file that is too large, and says so', () => {
    renderPreview(file('a.txt', TEXT_PREVIEW_MAX_BYTES + 1));
    renderPreview(file('a.png', MEDIA_PREVIEW_MAX_BYTES + 1));
    expect(fetchMock).not.toHaveBeenCalled();
    for (const size of ['2 MB', '26 MB'])
      expect(
        screen.getByText(t('storage.preview.tooLarge', { size })),
      ).toBeInTheDocument();
  });

  it('does not fetch a kind with no preview, and says so', () => {
    renderPreview(file('a.docx'));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByText(t('storage.preview.none'))).toBeInTheDocument();
  });

  it('offers a retry when the file cannot be loaded', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: 'no' }), { status: 500 }),
    );
    renderPreview(file('a.txt'));
    expect(
      await screen.findByText(t('storage.preview.error')),
    ).toBeInTheDocument();
  });
});
