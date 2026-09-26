import { useId } from 'react';
import { t } from '../../../strings';
import './CompanyVisualisation.css';
import TcpPhaserVisualisation from './TcpPhaserVisualisation';
import { useOfficeWorld } from './useOfficeWorld';

export interface CompanyVisualisationProps {
  readonly companyId: string;
}

/**
 * The company's office, drawn as an isometric scene. `useOfficeWorld` turns
 * the company's live roles, agents, tasks, assignments and enquiries into an
 * office world; `TcpPhaserVisualisation` draws it and reports back when an
 * avatar arrives at, or leaves, its target.
 *
 * Hover, selection, follow and keyboard panning are later steps — this stage
 * is the office itself, and a summary for anyone not looking at the canvas.
 */
export default function CompanyVisualisation({
  companyId,
}: CompanyVisualisationProps) {
  const { world, avatarArrived, avatarExited } = useOfficeWorld(companyId);
  const summaryId = useId();

  const roles = world.avatars.filter((avatar) => avatar.kind === 'role').length;
  const taskRooms = world.rooms.filter(
    (room) => room.purpose === 'task',
  ).length;
  const agents = world.avatars.filter(
    (avatar) => avatar.kind === 'agent',
  ).length;

  return (
    <section className="company-visualisation">
      <div
        className="company-visualisation__stage"
        role="group"
        aria-label={t('visualisation.stage.label')}
        aria-describedby={summaryId}
      >
        <TcpPhaserVisualisation
          world={world}
          onAvatarArrived={avatarArrived}
          onAvatarExited={avatarExited}
        />
      </div>
      <p id={summaryId} className="visually-hidden">
        {t('visualisation.summary', { roles, taskRooms, agents })}
      </p>
    </section>
  );
}
