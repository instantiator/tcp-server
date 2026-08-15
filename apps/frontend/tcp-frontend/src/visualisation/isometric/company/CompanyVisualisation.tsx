import { useCallback } from 'react';
import {
  useCompanyRolesList,
  useLiveCompanyAgentsList,
  useLiveCompanyTasksList,
} from '../../../api/hooks';
import './CompanyVisualisation.css';
import TcpPhaserVisualisation from './TcpPhaserVisualisation';

export interface CompanyVisualisationProps {
  readonly companyId: string;
}

/**
 * Live company visualisation - provides roles, agents, and tasks to the
 * {@link TcpPhaserVisualisation} component, which renders them in a
 * Phaser scene, tracking changes to these lists, passing back clicks
 * on game objects.
 */
export default function CompanyVisualisation({
  companyId,
}: CompanyVisualisationProps) {
  const { data: roles } = useCompanyRolesList(companyId);
  const { data: agents } = useLiveCompanyAgentsList(companyId);
  const { data: tasks } = useLiveCompanyTasksList(companyId);

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const onAgentClick = useCallback((_agentId: string) => {
    // TODO(000.01): show the task details dialog, opened at this agent's assignment
  }, []);

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const onRoleClick = useCallback((_roleId: string) => {
    // TODO(000.01): show a new chat dialog for this role
  }, []);

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const onTaskClick = useCallback((_taskId: string) => {
    // TODO(000.01): show the task details dialog
  }, []);

  return (
    <div className="company-visualisation__container">
      <TcpPhaserVisualisation
        companyId={companyId}
        roles={roles ?? []}
        agents={agents ?? []}
        tasks={tasks ?? []}
        onAgentClick={onAgentClick}
        onRoleClick={onRoleClick}
        onTaskClick={onTaskClick}
      />
    </div>
  );
}
