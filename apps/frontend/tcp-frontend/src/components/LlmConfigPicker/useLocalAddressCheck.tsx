import { isHostLocal, toDockerHost } from '@tcp/shared/client';
import { useState, type ReactNode } from 'react';
import { t } from '../../strings';
import { ConfirmDialog } from '../Dialog/ConfirmDialog';

interface Pending {
  readonly url: string;
  readonly resolve: (url: string) => void;
}

/**
 * Catches a `localhost` address on save. TCP's server runs in Docker, where
 * `localhost` is the container itself, so a model server on the person's own
 * computer is only reachable as `host.docker.internal`.
 *
 * `check(url)` resolves to the address to save: rewritten if the person
 * accepts, as typed if they decline. Render `dialog` somewhere in the form.
 */
export const useLocalAddressCheck = (
  portalContainer?: Element,
): { check: (url: string) => Promise<string>; dialog: ReactNode } => {
  const [pending, setPending] = useState<Pending | null>(null);

  const check = (url: string): Promise<string> =>
    isHostLocal(url)
      ? new Promise((resolve) => setPending({ url, resolve }))
      : Promise.resolve(url);

  const answer = (rewrite: boolean): void => {
    if (pending === null) return;
    pending.resolve(rewrite ? toDockerHost(pending.url) : pending.url);
    setPending(null);
  };

  const dialog = (
    <ConfirmDialog
      isOpen={pending !== null}
      heading={t('llm.local.heading')}
      message={t('llm.local.message', {
        host: pending === null ? '' : new URL(pending.url).hostname,
      })}
      confirmLabel={t('llm.local.replace')}
      cancelLabel={t('llm.local.keep')}
      onConfirm={() => answer(true)}
      onCancel={() => answer(false)}
      portalContainer={portalContainer}
    />
  );
  return { check, dialog };
};
