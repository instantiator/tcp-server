import { describe, expect, it } from 'vitest';
import { taskOutputsUrl } from './storageLink';

describe('taskOutputsUrl', () => {
  it('returns null without storageConsoleUrl', () => {
    expect(
      taskOutputsUrl({ storageBucket: 'tcp' }, 'acme-co', 'task-123'),
    ).toBeNull();
  });

  it('returns null without storageBucket', () => {
    expect(
      taskOutputsUrl(
        { storageConsoleUrl: 'http://localhost:9001' },
        'acme-co',
        'task-123',
      ),
    ).toBeNull();
  });

  it('returns null with neither field configured', () => {
    expect(taskOutputsUrl({}, 'acme-co', 'task-123')).toBeNull();
  });

  it('builds the confirmed Silo console format: /browser/{bucket}/{percent-encoded prefix}', () => {
    // Confirmed against a running Silo container (pgsty/silo) in stage 9:
    // the prefix keeps its trailing slash and is percent-encoded as one path
    // segment — not base64, which is MinIO's classic console format and
    // which Silo's console does not decode.
    const url = taskOutputsUrl(
      { storageConsoleUrl: 'http://localhost:9001', storageBucket: 'tcp' },
      'acme-co',
      'task-123',
    );

    expect(url).toBe(
      'http://localhost:9001/browser/tcp/acme-co%2Ftasks%2Ftask-123%2Fcompleted%2F',
    );
  });

  it('strips a trailing slash from storageConsoleUrl before joining', () => {
    const url = taskOutputsUrl(
      { storageConsoleUrl: 'http://localhost:9001/', storageBucket: 'tcp' },
      'acme-co',
      'task-123',
    );

    expect(url).toBe(
      'http://localhost:9001/browser/tcp/acme-co%2Ftasks%2Ftask-123%2Fcompleted%2F',
    );
  });

  it('percent-encodes a company slug or task id that needs it', () => {
    // A slug or id with a slash, space or other reserved character must not
    // corrupt the path or escape the intended prefix.
    const url = taskOutputsUrl(
      { storageConsoleUrl: 'http://localhost:9001', storageBucket: 'tcp' },
      'acme & co',
      'task/123',
    );

    expect(url).toBe(
      'http://localhost:9001/browser/tcp/' +
        encodeURIComponent('acme & co/tasks/task/123/completed/'),
    );
    // The task id's own "/" must be encoded away, not left as a path
    // separator that would escape the intended segment.
    expect(url?.split('/browser/tcp/')[1]).not.toContain('/');
  });
});
