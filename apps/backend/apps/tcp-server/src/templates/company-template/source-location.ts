import * as path from 'path';
import { BadRequestException } from '@nestjs/common';

/** A parsed template source location. */
export type SourceLocation =
  | { kind: 'github'; owner: string; repo: string; path: string; ref: string }
  | { kind: 'directory'; path: string };

const OWNER_REPO = /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/;
const PATH_PART = /^[A-Za-z0-9._-]+$/;
const REF = /^[A-Za-z0-9._/-]+$/;

/** The branch read when a GitHub location names none. */
export const DEFAULT_REF = 'main';

/**
 * Parses `github:<owner>/<repo>[/<path>][#<ref>]` or `dir:<absolute path>`.
 *
 * The GitHub form is checked part by part, because its parts become a URL on
 * a fixed host: nothing here can point a fetch anywhere but
 * codeload.github.com, or climb out of the repository with `..`.
 *
 * @throws {@link BadRequestException} naming what is wrong.
 */
export function parseLocation(location: string): SourceLocation {
  if (location.startsWith('dir:')) {
    const dir = location.slice('dir:'.length);
    if (!path.isAbsolute(dir)) {
      throw new BadRequestException(
        `A dir: source needs an absolute path: ${dir}`,
      );
    }
    return { kind: 'directory', path: path.normalize(dir) };
  }
  if (location.startsWith('github:')) {
    const [spec, ref = DEFAULT_REF, ...extra] = location
      .slice('github:'.length)
      .split('#');
    const [owner, repo, ...parts] = spec.split('/');
    const ok =
      extra.length === 0 &&
      repo !== undefined &&
      OWNER_REPO.test(`${owner}/${repo}`) &&
      parts.every((p) => PATH_PART.test(p) && p !== '..' && p !== '.') &&
      REF.test(ref) &&
      !ref.split('/').includes('..');
    if (!ok) {
      throw new BadRequestException(
        `Not a GitHub source: ${location}. Use github:<owner>/<repo>[/<path>][#<ref>].`,
      );
    }
    return { kind: 'github', owner, repo, path: parts.join('/'), ref };
  }
  throw new BadRequestException(
    `A template source starts with github: or dir: (got ${location}).`,
  );
}

/** Writes a GitHub location in its canonical form. */
export function githubLocation(
  repo: string,
  subpath = '',
  ref = DEFAULT_REF,
): string {
  const where = subpath.replace(/^\/+|\/+$/g, '');
  const location = `github:${repo}${where ? `/${where}` : ''}#${ref || DEFAULT_REF}`;
  parseLocation(location);
  return location;
}

/** Splits the `TEMPLATE_SOURCES` setting into locations. */
export function configuredLocations(setting: string): string[] {
  return setting
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}
