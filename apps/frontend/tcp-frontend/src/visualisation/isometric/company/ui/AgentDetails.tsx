import {
  useCompanyRolesList,
  useLiveAgentState,
  useLiveAssignmentsList,
} from '../../../../api/hooks';
import { Ear } from 'lucide-react';
import {
  ACTIVE_AGENT_STATUSES,
  agentStatusLabel,
  statusLabel,
} from '../../../../api/statuses';
import { ExpandableText } from '../../../../components/ExpandableText/ExpandableText';
import { RoundIconButton } from '../../../../components/RoundIconButton/RoundIconButton';
import { t } from '../../../../strings';
import { isWaitingToStart } from '../rules/companySnapshot';
import { modeLabel } from '../../../../api/modeLabel';
import { TrayPanel } from './TrayPanel';
import { useListenIn } from './useListenIn';

export interface AgentDetailsProps {
  readonly companyId: string;
  readonly agentId: string;
  readonly headingId: string;
  /** Where tooltips are portalled; see `VisualisationTrayProps.portalContainer`. */
  readonly portalContainer?: Element | undefined;
}

/**
 * One agent's live details in the office tray: its role, its own status, and
 * the assignment it is working — its mode, its status and (as the
 * description) its prompt — with a Listen in action while it is active.
 *
 * The assignment comes from the company's whole assignments list, filtered to
 * the one id the agent names, rather than a per-id fetch: `useOfficeWorld`
 * already holds that same list for the rules, so this reuses its cache entry
 * instead of opening a second query for the same rows.
 */
export const AgentDetails = ({
  companyId,
  agentId,
  headingId,
  portalContainer,
}: AgentDetailsProps) => {
  const agentQuery = useLiveAgentState({ agentId });
  const listenIn = useListenIn(companyId);
  const { data: roles } = useCompanyRolesList(companyId);
  const { data: assignments } = useLiveAssignmentsList({ companyId });

  if (agentQuery.isPending) {
    return (
      <TrayPanel
        headingId={headingId}
        heading={t('visualisation.tray.heading')}
      >
        <p>{t('visualisation.tray.loading')}</p>
      </TrayPanel>
    );
  }

  // An id nobody created 404s (isError) rather than answering 200 with null —
  // `useCompany`'s null-body behaviour is documented in `api/hooks.ts` as a
  // special case, not the rule. Both read as "gone" here.
  const agent = agentQuery.data;
  if (agentQuery.isError || agent === null || agent === undefined) {
    return (
      <TrayPanel
        headingId={headingId}
        heading={t('visualisation.tray.heading')}
      >
        <p>{t('visualisation.tray.gone')}</p>
      </TrayPanel>
    );
  }

  const roleName =
    roles?.find((role) => role.id === agent.roleId)?.name ??
    t('activity.role.unknown');
  const assignment = assignments?.find((row) => row.id === agent.assignmentId);
  // The raw status reads "idle" even while the office shows the avatar
  // waiting by its role's book (decision 4, 002.02 stage 4) — same reading
  // as the office, from the same condition, so the tray doesn't call this a
  // bug.
  const statusText =
    assignment !== undefined && isWaitingToStart(agent.status, assignment)
      ? t('visualisation.activity.waiting')
      : agentStatusLabel(agent);

  // Only while the agent is active: a finished agent has nothing more to
  // say, and its whole history is in the task dialog. The name carries the
  // role so it reads on its own in the tray (WCAG 2.4.6).
  const canListenIn = ACTIVE_AGENT_STATUSES.some(
    (active) => active === agent.status,
  );

  return (
    <TrayPanel
      headingId={headingId}
      heading={t('visualisation.tray.agentHeading', { role: roleName })}
      actions={
        canListenIn ? (
          <RoundIconButton
            icon={Ear}
            label={t('visualisation.tray.listenIn', { role: roleName })}
            portalContainer={portalContainer}
            onPress={() => {
              listenIn({
                id: agentId,
                roleId: agent.roleId,
                assignmentId: agent.assignmentId,
              });
            }}
          />
        ) : undefined
      }
      description={
        assignment === undefined ? undefined : (
          <ExpandableText
            text={assignment.prompt}
            variant="icon"
            expandLabel={t('visualisation.tray.prompt.expand')}
            collapseLabel={t('visualisation.tray.prompt.collapse')}
            portalContainer={portalContainer}
          />
        )
      }
    >
      <dl>
        <dt>{t('visualisation.tray.status')}</dt>
        <dd>{statusText}</dd>
        {assignment !== undefined && (
          <>
            <dt>{t('visualisation.tray.mode')}</dt>
            <dd>{modeLabel(assignment.mode)}</dd>
            <dt>{t('visualisation.tray.assignmentStatus')}</dt>
            <dd>{statusLabel(assignment.status)}</dd>
          </>
        )}
      </dl>
    </TrayPanel>
  );
};
