import {
  configuredLocations,
  githubLocation,
  parseLocation,
} from './source-location';

describe('parseLocation', () => {
  it.each([
    [
      'github:acme/templates',
      {
        kind: 'github',
        owner: 'acme',
        repo: 'templates',
        path: '',
        ref: 'main',
      },
    ],
    [
      'github:acme/tcp.templates/packs/uk#v1.2',
      {
        kind: 'github',
        owner: 'acme',
        repo: 'tcp.templates',
        path: 'packs/uk',
        ref: 'v1.2',
      },
    ],
    [
      'github:acme/t#release/2026',
      {
        kind: 'github',
        owner: 'acme',
        repo: 't',
        path: '',
        ref: 'release/2026',
      },
    ],
    ['dir:/srv/templates/', { kind: 'directory', path: '/srv/templates/' }],
  ])('reads %s', (location, expected) => {
    expect(parseLocation(location)).toEqual(expected);
  });

  it.each([
    ['no scheme', 'acme/templates'],
    ['another scheme', 'https://github.com/acme/templates'],
    ['a relative dir', 'dir:templates'],
    ['a missing repo', 'github:acme'],
    ['a parent segment in the path', 'github:acme/t/../x'],
    ['a parent segment in the ref', 'github:acme/t#a/../b'],
    ['a host smuggled into the owner', 'github:evil.com@acme/t'],
    ['a query in the ref', 'github:acme/t#main?x=1'],
    ['two refs', 'github:acme/t#a#b'],
  ])('refuses %s', (_label, location) => {
    expect(() => parseLocation(location)).toThrow();
  });
});

describe('githubLocation', () => {
  it('writes the canonical form, defaulting the ref', () => {
    expect(githubLocation('acme/t', '/packs/', '')).toBe(
      'github:acme/t/packs#main',
    );
  });

  it('refuses a bad repo', () => {
    expect(() => githubLocation('acme', '', 'main')).toThrow();
  });
});

describe('configuredLocations', () => {
  it('splits on commas and drops blanks', () => {
    expect(configuredLocations(' github:a/b , ,dir:/x')).toEqual([
      'github:a/b',
      'dir:/x',
    ]);
    expect(configuredLocations('')).toEqual([]);
  });
});
