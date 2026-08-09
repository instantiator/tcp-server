import { useMemo } from 'react';
import { useCompanyRoles } from '../../../api/queries';
import {
  AgentsList,
  ConsultationsList,
  EnquiriesList,
  TasksList,
} from './lists';
import './activity.css';

export interface CompanyActivityProps {
  readonly companyId: string;
}

/**
 * The live activity view: agents, tasks, consultations and enquiries for one
 * company, in one tab panel.
 *
 * **This opens no event stream of its own.** `CompanyPage` already subscribes
 * to `streamUrls.company(companyId)`, and every event patches the TanStack
 * Query cache these lists read (ADR-025) — so the four lists below stay live
 * without a second subscription, and `MAX_STREAMS` is untouched.
 *
 * Role names are fetched once here, rather than once per list, because four
 * lists each fetching the same company's roles would be four identical
 * requests for the same answer.
 */
export const CompanyActivity = ({ companyId }: CompanyActivityProps) => {
  const { data: roles } = useCompanyRoles(companyId);
  const roleNames = useMemo(
    () => new Map((roles ?? []).map((role) => [role.id, role.name])),
    [roles],
  );

  return (
    <div className="company-activity">
      <AgentsList companyId={companyId} roleNames={roleNames} />
      {/* No `roleNames`: a task belongs to a company, not to a role. */}
      <TasksList companyId={companyId} />
      <ConsultationsList companyId={companyId} roleNames={roleNames} />
      <EnquiriesList companyId={companyId} />
    </div>
  );
};
