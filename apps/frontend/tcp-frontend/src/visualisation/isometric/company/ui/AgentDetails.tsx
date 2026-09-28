import {
  useCompanyRolesList,
  useLiveAgentState,
  useLiveAssignmentsList,
} from '../../../../api/hooks';
import { Button } from 'react-aria-components';
import { ACTIVE_AGENT_STATUSES, statusLabel } from '../../../../api/statuses';
import { useChat } from '../../../../components/ChatDialog/useChat';
import { ExpandableText } from '../../../../components/ExpandableText/ExpandableText';
import { t } from '../../../../strings';
import { isWaitingToStart } from '../rules/companySnapshot';
import { modeLabel } from './modeLabel';

export interface AgentDetailsProps {
  readonly companyId: string;
  readonly agentId: string;
  readonly headingId: string;
}

/**
 * One agent's live details in the office tray: its role, its own status, and
 * the assignment it is working — its mode, its status and its prompt.
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
}: AgentDetailsProps) => {
  const agentQuery = useLiveAgentState({ agentId });
  const { openChat } = useChat();
  const { data: roles } = useCompanyRolesList(companyId);
  const { data: assignments } = useLiveAssignmentsList({ companyId });

  if (agentQuery.isPending) {
    return (
      <>
        <h2 id={headingId}>{t('visualisation.tray.heading')}</h2>
        <p>{t('visualisation.tray.loading')}</p>
      </>
    );
  }

  // An id nobody created 404s (isError) rather than answering 200 with null —
  // `useCompany`'s null-body behaviour is documented in `api/hooks.ts` as a
  // special case, not the rule. Both read as "gone" here.
  const agent = agentQuery.data;
  if (agentQuery.isError || agent === null || agent === undefined) {
    return (
      <>
        <h2 id={headingId}>{t('visualisation.tray.heading')}</h2>
        <p>{t('visualisation.tray.gone')}</p>
      </>
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
      : statusLabel(agent.status);

  return (
    <>
      <h2 id={headingId}>
        {t('visualisation.tray.agentHeading', { role: roleName })}
      </h2>
      <dl>
        <dt>{t('visualisation.tray.status')}</dt>
        <dd>{statusText}</dd>
        {assignment !== undefined && (
          <>
            <dt>{t('visualisation.tray.mode')}</dt>
            <dd>{modeLabel(assignment.mode)}</dd>
            <dt>{t('visualisation.tray.assignmentStatus')}</dt>
            <dd>{statusLabel(assignment.status)}</dd>
            <dt>{t('visualisation.tray.prompt')}</dt>
            <dd>
              <ExpandableText
                text={assignment.prompt}
                variant="ellipsis"
                expandLabel={t('visualisation.tray.prompt.expand')}
                collapseLabel={t('visualisation.tray.prompt.collapse')}
              />
            </dd>
          </>
        )}
      </dl>
      {/*
        Only while the agent is active: a finished agent has nothing more to
        say, and its whole history is in the task dialog. The name carries the
        role so it reads on its own in the tray (WCAG 2.4.6).
      */}
      {ACTIVE_AGENT_STATUSES.some((active) => active === agent.status) && (
        <Button
          className="react-aria-Button"
          onPress={() => {
            openChat({
              agentId,
              roleName,
              reference: assignment?.shortcode ?? null,
              readOnly: true,
            });
          }}
        >
          {t('visualisation.tray.listenIn', { role: roleName })}
        </Button>
      )}
    </>
  );
};
