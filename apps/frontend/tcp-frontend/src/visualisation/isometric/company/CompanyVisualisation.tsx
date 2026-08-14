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

  const onAgentClick = useCallback((agentId: string) => {
    console.log(`Agent clicked: ${agentId}`);
  }, []);

  const onRoleClick = useCallback((roleId: string) => {
    console.log(`Role clicked: ${roleId}`);
  }, []);

  const onTaskClick = useCallback((taskId: string) => {
    console.log(`Task clicked: ${taskId}`);
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
