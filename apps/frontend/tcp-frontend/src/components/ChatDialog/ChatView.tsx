import { Archive, Trash2 } from 'lucide-react';
import { useId, useState, type Ref } from 'react';
import {
  useCompleteChat,
  useDeleteChat,
  useLiveAgentState,
} from '../../api/hooks';
import { t } from '../../strings';
import { ConfirmDialog } from '../Dialog/ConfirmDialog';
import { ErrorState } from '../ErrorState/ErrorState';
import { RoundIconButton } from '../RoundIconButton/RoundIconButton';
import { ReasoningRuleMenu } from '../Transcript/ReasoningRuleMenu';
import { Transcript } from '../Transcript/Transcript';
import { isTerminalAgentStatus } from './agentStatus';
import { MessageInput } from './MessageInput';
import type { Conversation } from './useChat';

export interface ChatViewProps {
  readonly conversation: Conversation;
  /** Archives a listened-in view. Role chats archive by completing instead. */
  readonly onArchiveEavesdrop: (agentId: string) => void;
  /**
   * Called once the view has left the list — archived or deleted — so the
   * dialog can clear the selection and put focus back in the list.
   */
  readonly onGone: () => void;
  readonly sectionRef: Ref<HTMLElement>;
}

/** The view's heading: who, and whether it is a chat or listening in. */
const headingFor = ({ roleName, reference, readOnly }: Conversation): string =>
  readOnly === true
    ? reference === null
      ? t('chat.conversation.listening', { role: roleName })
      : t('chat.conversation.listeningWithReference', {
          role: roleName,
          reference,
        })
    : reference === null
      ? t('chat.conversation.label', { role: roleName })
      : t('chat.conversation.labelWithReference', {
          role: roleName,
          reference,
        });

/**
 * The right pane of the chat dialog: one view's heading with its controls,
 * its transcript, and — for a role chat — the message form.
 *
 * Only the selected view is mounted, so the dialog holds one event stream, not
 * one per chat (ADR-025's budget). The parent keys this by agent, so switching
 * views starts a fresh transcript rather than carrying one's state into the
 * next.
 *
 * **Archive** completes a role chat (it can't be re-opened), and only hides a
 * listened-in view — listening in never stops the agent. **Delete** is for
 * role chats only, and asks first. Each control's name says which chat it
 * acts on (WCAG 2.4.6).
 */
export const ChatView = ({
  conversation,
  onArchiveEavesdrop,
  onGone,
  sectionRef,
}: ChatViewProps) => {
  const { agentId, roleName } = conversation;
  const readOnly = conversation.readOnly ?? false;
  const headingId = useId();

  const complete = useCompleteChat(agentId);
  const remove = useDeleteChat(agentId);
  const { data: agent } = useLiveAgentState({ agentId });
  const status = agent?.status;
  const finished = isTerminalAgentStatus(status);
  const running = status === 'running';

  const [confirmingDelete, setConfirmingDelete] = useState(false);

  return (
    <section
      className="chat-view"
      aria-labelledby={headingId}
      tabIndex={-1}
      ref={sectionRef}
    >
      <div className="chat-view__header">
        <h3 id={headingId} className="chat-view__heading">
          {headingFor(conversation)}
        </h3>
        {readOnly ? (
          <RoundIconButton
            icon={Archive}
            outline
            label={t('chat.archive.listening', { role: roleName })}
            onPress={() => {
              onArchiveEavesdrop(agentId);
              onGone();
            }}
          />
        ) : (
          !finished && (
            <RoundIconButton
              icon={Archive}
              outline
              label={t('chat.complete', { role: roleName })}
              isDisabled={running || complete.isPending}
              onPress={() => {
                complete.mutate(undefined, { onSuccess: onGone });
              }}
            />
          )
        )}
        {!readOnly && (
          <RoundIconButton
            icon={Trash2}
            outline
            label={t('chat.delete', { role: roleName })}
            isDisabled={running || remove.isPending}
            onPress={() => {
              setConfirmingDelete(true);
            }}
          />
        )}
        <ReasoningRuleMenu />
      </div>

      <Transcript agentId={agentId} roleName={roleName} />

      {/* Listening in is not a conversation: nothing to send. */}
      {!readOnly && (
        <MessageInput agentId={agentId} roleName={roleName} status={status} />
      )}

      {/*
        Their own announcer channels, not the `chat:` one the message form
        uses: two failures on one channel coalesce into one phrase, and these
        are different things to be told about.
      */}
      {complete.isError && (
        <ErrorState
          message={t('chat.complete.failed')}
          channel={`chat-complete:${agentId}`}
        />
      )}
      {remove.isError && (
        <ErrorState
          message={t('chat.delete.failed')}
          channel={`chat-delete:${agentId}`}
        />
      )}

      <ConfirmDialog
        isOpen={confirmingDelete}
        heading={t('chat.delete.confirm.heading')}
        message={t('chat.delete.confirm.body', { role: roleName })}
        confirmLabel={t('chat.delete.confirm.accept')}
        cancelLabel={t('chat.delete.confirm.reject')}
        onConfirm={() => {
          setConfirmingDelete(false);
          remove.mutate(undefined, {
            onSuccess: onGone,
          });
        }}
        onCancel={() => {
          setConfirmingDelete(false);
        }}
      />
    </section>
  );
};
