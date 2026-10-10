import { Button } from 'react-aria-components';
import { useSystemHealth } from '../../api/hooks';
import { t, tCount } from '../../strings';
import { Dialog } from '../Dialog/Dialog';
import { ErrorState } from '../ErrorState/ErrorState';
import { LoadingState } from '../LoadingState/LoadingState';
import './SystemHealthDialog.css';

export interface SystemHealthDialogProps {
  readonly onClose: () => void;
}

/**
 * The state of every service the system depends on, for an administrator.
 *
 * Each status is written in words, never by colour alone. A service that is
 * down shows its error beneath it, and the raw report sits in a disclosure for
 * anyone who needs the detail. Refresh asks again; nothing polls.
 */
export const SystemHealthDialog = ({ onClose }: SystemHealthDialogProps) => {
  const { data, isPending, isError, refetch } = useSystemHealth();
  const downCount =
    data?.services.filter((service) => service.status === 'down').length ?? 0;

  return (
    <Dialog onClose={onClose} heading={t('systemHealth.heading')}>
      {isPending && <LoadingState label={t('systemHealth.loading')} />}

      {isError && (
        <ErrorState
          message={t('systemHealth.error')}
          channel="system-health"
          onRetry={() => {
            void refetch();
          }}
        />
      )}

      {data !== undefined && (
        <>
          <p>
            {data.status === 'ok'
              ? t('systemHealth.allUp')
              : tCount('systemHealth.down', downCount)}
          </p>
          <ul className="system-health-dialog__services">
            {data.services.map((service) => (
              <li key={service.name}>
                {t('systemHealth.service', {
                  name: service.name,
                  status: t(`systemHealth.status.${service.status}`),
                })}
                {service.status === 'down' && service.error !== undefined && (
                  <div className="system-health-dialog__error">
                    {service.error}
                  </div>
                )}
              </li>
            ))}
          </ul>
          <Button
            className="react-aria-Button"
            onPress={() => {
              void refetch();
            }}
          >
            {t('systemHealth.refresh')}
          </Button>
          <details>
            <summary>{t('systemHealth.fullReport')}</summary>
            <pre>{JSON.stringify(data, null, 2)}</pre>
          </details>
        </>
      )}
    </Dialog>
  );
};
