import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEV_SESSION_PARAM, readDevSession } from './dev-session';

describe('readDevSession', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reads a stand-in session from the query string', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(readDevSession(`?${DEV_SESSION_PARAM}=alice`)).toEqual({
      userId: 'alice',
    });
  });

  it('warns that the session is a development-only stand-in', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    readDevSession(`?${DEV_SESSION_PARAM}=alice`);

    // A stand-in session is otherwise indistinguishable from being signed in,
    // and someone who does not know which they are looking at will misread
    // every behaviour that depends on it.
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toContain(DEV_SESSION_PARAM);
  });

  it.each([
    ['no query string at all', ''],
    ['an unrelated parameter', '?theme=dark'],
    ['the parameter present but empty', `?${DEV_SESSION_PARAM}=`],
    ['the parameter set to whitespace', `?${DEV_SESSION_PARAM}=%20%20`],
  ])('returns null given %s', (_case, search) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(readDevSession(search)).toBeNull();
    // Silence matters as much as the null: a warning on every ordinary page
    // load would train everyone to ignore the one that means something.
    expect(warn).not.toHaveBeenCalled();
  });

  it('does not treat a same-named hash or path segment as the parameter', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    // `window.location.search` never contains these, but the function takes a
    // string and this pins down that it parses rather than pattern-matches.
    expect(readDevSession(`#${DEV_SESSION_PARAM}=alice`)).toBeNull();
    expect(readDevSession(`/${DEV_SESSION_PARAM}/alice`)).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });
});
