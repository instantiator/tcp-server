import { useEffect, useState } from 'react';
import { useStorageFileBlob, type StorageFileEntryDTO } from '../../api/hooks';
import { t } from '../../strings';
import { ErrorState } from '../ErrorState/ErrorState';
import { LoadingState } from '../LoadingState/LoadingState';
import { Markdown } from '../Transcript/Markdown';
import { parseCsv } from './csv';
import { mimeFor, previewKind } from './previewKind';
import './FilePreview.css';

/** Rows a CSV preview shows; more is a download, not a screenful. */
const CSV_MAX_ROWS = 500;

const megabyteFormat = new Intl.NumberFormat(undefined, {
  style: 'unit',
  unit: 'megabyte',
  maximumFractionDigits: 0,
});

/** A size in whole megabytes, rounding up so a big file never reads as 0 MB. */
const formatMegabytes = (bytes: number): string =>
  megabyteFormat.format(Math.ceil(bytes / (1024 * 1024)));

/** A blob's text, or undefined until it has been read. */
const useBlobText = (blob: Blob): string | undefined => {
  const [read, setRead] = useState<{ blob: Blob; text: string }>();
  useEffect(() => {
    let cancelled = false;
    void blob.text().then((text) => {
      if (!cancelled) setRead({ blob, text });
    });
    return () => {
      cancelled = true;
    };
  }, [blob]);
  return read?.blob === blob ? read.text : undefined;
};

/** A blob as an object URL for as long as the component shows it. */
const useObjectUrl = (blob: Blob, name: string): string | undefined => {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    const objectUrl = URL.createObjectURL(
      new Blob([blob], { type: mimeFor(name) }),
    );
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [blob, name]);
  return url;
};

/** Markdown, CSV or plain text, read from the blob once it has loaded. */
const TextPreview = ({
  blob,
  file,
  kind,
}: {
  readonly blob: Blob;
  readonly file: StorageFileEntryDTO;
  readonly kind: 'markdown' | 'csv' | 'text';
}) => {
  const text = useBlobText(blob);
  if (text === undefined)
    return <LoadingState label={t('storage.preview.loading')} />;

  if (kind === 'markdown') return <Markdown text={text} />;
  if (kind === 'text')
    return (
      <pre
        className="file-preview__text"
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- a scrollable region must be focusable so keyboard users can scroll it
        tabIndex={0}
        role="region"
        aria-label={file.name}
      >
        {text}
      </pre>
    );

  const { rows, truncated } = parseCsv(text, CSV_MAX_ROWS);
  const [head, ...body] = rows;
  if (head === undefined) return <p>{t('storage.preview.none')}</p>;
  return (
    <>
      <table className="tcp-table">
        <caption>{file.name}</caption>
        <thead>
          <tr>
            {head.map((cell, i) => (
              <th key={i} scope="col">
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((row, r) => (
            <tr key={r}>
              {row.map((cell, i) => (
                <td key={i}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {truncated && (
        <p>{t('storage.preview.truncated', { count: CSV_MAX_ROWS })}</p>
      )}
    </>
  );
};

/** An image or PDF, shown by the browser itself from an object URL. */
const MediaPreview = ({
  blob,
  file,
  kind,
}: {
  readonly blob: Blob;
  readonly file: StorageFileEntryDTO;
  readonly kind: 'image' | 'pdf';
}) => {
  const src = useObjectUrl(blob, file.name);
  if (src === undefined)
    return <LoadingState label={t('storage.preview.loading')} />;
  // SVG only ever loads through <img>, where its scripts cannot run.
  return kind === 'image' ? (
    <img className="file-preview__media" alt={file.name} src={src} />
  ) : (
    <iframe className="file-preview__media" title={file.name} src={src} />
  );
};

/**
 * A stored file's content shown in place: markdown rendered, CSV as a table,
 * text literally (HTML included, never rendered), images and PDFs from an
 * object URL. Files with no preview, or too large, say so instead.
 */
export const FilePreview = ({
  companyId,
  file,
}: {
  readonly companyId: string;
  readonly file: StorageFileEntryDTO;
}) => {
  const kind = previewKind(file.name, file.size);
  const query = useStorageFileBlob(companyId, file.path, {
    enabled: kind !== 'none' && kind !== 'tooLarge',
  });

  if (kind === 'none') return <p>{t('storage.preview.none')}</p>;
  if (kind === 'tooLarge')
    return (
      <p>
        {t('storage.preview.tooLarge', { size: formatMegabytes(file.size) })}
      </p>
    );
  if (query.isError)
    return (
      <ErrorState
        message={t('storage.preview.error')}
        channel="storage"
        onRetry={() => void query.refetch()}
      />
    );
  if (query.data === undefined)
    return <LoadingState label={t('storage.preview.loading')} />;

  return kind === 'image' || kind === 'pdf' ? (
    <MediaPreview blob={query.data} file={file} kind={kind} />
  ) : (
    <TextPreview blob={query.data} file={file} kind={kind} />
  );
};
