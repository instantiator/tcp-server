const kilobytes = new Intl.NumberFormat(undefined, {
  style: 'unit',
  unit: 'kilobyte',
  maximumFractionDigits: 0,
});
const megabytes = new Intl.NumberFormat(undefined, {
  style: 'unit',
  unit: 'megabyte',
  maximumFractionDigits: 1,
});
const dateTime = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

/** A file size for people: whole kilobytes (rounded up, so never 0 kB) below 1 MB, megabytes above. */
export const formatSize = (bytes: number): string =>
  bytes < 1024 * 1024
    ? kilobytes.format(Math.max(1, Math.ceil(bytes / 1024)))
    : megabytes.format(bytes / (1024 * 1024));

/** When a file or version was saved, in the reader's own time zone. */
export const savedAt = (iso: string): string => dateTime.format(new Date(iso));
