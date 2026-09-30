/**
 * Rewrites a `localhost`-flavoured URL so a container reaches the host
 * machine instead of itself — `docker-compose.yml`'s `extra_hosts` maps
 * `host.docker.internal` to the host on every platform, including Linux.
 */
function parseHostname(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

// `URL#hostname` keeps an IPv6 host's brackets (`[::1]`), unlike the rest of
// its authority parsing — so `[::1]` is the literal form to check for and,
// in toDockerHost, the literal text already in the URL to replace.
function isLocalHostname(hostname: string): boolean {
  return (
    hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
  );
}

/** Whether `url` points at the machine the wizard itself runs on. */
export function isHostLocal(url: string): boolean {
  const hostname = parseHostname(url);
  return hostname !== undefined && isLocalHostname(hostname);
}

/**
 * Replaces only the host part of a local URL with `host.docker.internal`,
 * leaving the scheme, port and path exactly as given. Returns `url`
 * unchanged when it isn't local — see {@link isHostLocal}.
 */
export function toDockerHost(url: string): string {
  const hostname = parseHostname(url);
  if (!hostname || !isLocalHostname(hostname)) return url;

  const authorityStart = url.indexOf('://') + 3;
  const hostIndex = url.indexOf(hostname, authorityStart);
  if (hostIndex === -1) return url;

  return `${url.slice(0, hostIndex)}host.docker.internal${url.slice(hostIndex + hostname.length)}`;
}
