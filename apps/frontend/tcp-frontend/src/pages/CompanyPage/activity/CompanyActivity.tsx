import { useMemo } from 'react';
import { useCompanyRolesList } from '../../../api/hooks';
import { AgentsList } from './AgentsList';
import { ChatsList } from './ChatsList';
import { ConsultationsList } from './ConsultationsList';
import { EnquiriesList } from './EnquiriesList';
import { TasksList } from './TasksList';
import './activity.css';

export interface CompanyActivityProps {
  readonly companyId: string;
}

/**
 * The live activity view: agents, tasks, consultations, enquiries and chats
 * for one company, in one tab panel.
 *
 * **This opens no event stream of its own.** `CompanyPage` already subscribes
 * to `streamUrls.company(companyId)`, and every event patches the TanStack
 * Query cache these lists read (ADR-025) — so the five lists below stay live
 * without a second subscription, and `MAX_STREAMS` is untouched. The chats
 * list is no exception: opening a chat's own stream belongs to the chat
 * *dialog* (008.02), and only while a conversation is showing in it.
 *
 * Role names are fetched once here, rather than once per list, because five
 * lists each fetching the same company's roles would be five identical
 * requests for the same answer.
 */
export const CompanyActivity = ({ companyId }: CompanyActivityProps) => {
  const { data: roles } = useCompanyRolesList(companyId);
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
      <ChatsList companyId={companyId} roleNames={roleNames} />
    </div>
  );
};
