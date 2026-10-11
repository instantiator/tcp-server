/** Two digits, zero-padded. */
function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * The file name for a records download, e.g. `2026-10-11 14-05-09 acme orders.csv`
 * or `… acme tables.zip`. The time is local to whatever makes the file, and
 * uses `-` rather than `:` because Windows refuses colons in file names.
 */
export function recordsDownloadName(
  companySlug: string,
  label: string,
  extension: 'csv' | 'zip',
  at: Date = new Date(),
): string {
  const date = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
  const time = `${pad(at.getHours())}-${pad(at.getMinutes())}-${pad(at.getSeconds())}`;
  return `${date} ${time} ${companySlug} ${label}.${extension}`;
}
