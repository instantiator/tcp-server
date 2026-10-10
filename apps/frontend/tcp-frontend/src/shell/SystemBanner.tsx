import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { announce } from '../announce/announcer';
import { useSystemStatus } from '../api/hooks';
import type { StringKey } from '../strings';
import { t } from '../strings';
import './SystemBanner.css';

/** Idle is quiet, so it is asked about rarely; anything else is watched closely. */
const IDLE_POLL_MS = 30_000;
const ACTIVE_POLL_MS = 5_000;

/**
 * A notice, on every page, while the system is shutting down, restarting or
 * unreachable. For every signed-in user: they are the ones whose work stops.
 *
 * When the server comes back after being unreachable, every query is
 * invalidated so open pages show the restarted system rather than what they
 * held before it went down. TanStack keeps the last good answer through a
 * failed poll, which is how a failure after a restart is told apart from any
 * other unreachable server.
 *
 * No dismiss button: it ends when the system is back. Like
 * `SessionExpiryWarning`, it mounts no live region of its own (ADR-027); each
 * new text goes through the one announcer.
 */
export const SystemBanner = () => {
  const queryClient = useQueryClient();
  const { data, isError } = useSystemStatus({
    refetchInterval: (query) =>
      query.state.data?.shutdown.state === 'idle' &&
      query.state.status !== 'error'
        ? IDLE_POLL_MS
        : ACTIVE_POLL_MS,
  });

  const shutdown = data?.shutdown;
  let key: StringKey | null = null;
  if (isError) {
    key =
      shutdown?.restart === true
        ? 'banner.system.restarting'
        : 'banner.system.unreachable';
  } else if (shutdown?.state === 'draining') {
    key = shutdown.restart
      ? 'banner.system.restartDraining'
      : 'banner.system.draining';
  } else if (shutdown?.state === 'quiesced') {
    key = shutdown.restart
      ? 'banner.system.restarting'
      : 'banner.system.quiesced';
  }

  // Keyed on the text itself, not on "have I run?": StrictMode runs effects
  // twice on mount and a boolean guard would be spent by the first.
  const announced = useRef<StringKey | null>(null);
  useEffect(() => {
    if (key === announced.current) return;
    announced.current = key;
    if (key !== null) announce({ channel: 'system-banner', change: key });
  }, [key]);

  const wasError = useRef(false);
  useEffect(() => {
    if (wasError.current && !isError) void queryClient.invalidateQueries();
    wasError.current = isError;
  }, [isError, queryClient]);

  if (key === null) return null;

  return (
    <div
      className="system-banner"
      role="group"
      aria-label={t('banner.system.label')}
    >
      <p className="system-banner__message">{t(key)}</p>
    </div>
  );
};
