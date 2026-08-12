import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type SubmitEvent,
} from 'react';
import { Button } from 'react-aria-components';
import { ApiError } from '../../api/errors';
import { useLiveEnquiryState, useReplyToEnquiry } from '../../api/hooks';
import { t, type StringKey } from '../../strings';
import { Dialog } from '../Dialog/Dialog';
import { EmptyState } from '../EmptyState/EmptyState';
import { ErrorState } from '../ErrorState/ErrorState';
import { focusFirstInvalid } from '../Field/focusFirstInvalid';
import { TextField } from '../Field/TextField';
import { LoadingState } from '../LoadingState/LoadingState';
import './ResponseDialog.css';

export interface ResponseDialogProps {
  readonly slug: string;
  readonly onClose: () => void;
}

/**
 * A timestamp in the company's own zone, not the browser's — the person
 * answering may be nowhere near the company whose agent asked. Falls back to
 * the browser's zone when the company has none, and when the zone string is
 * one `Intl` refuses: a bad zone must not blank the whole conversation.
 */
const formatTime = (iso: string, timeZone: string | null): string => {
  const date = new Date(iso);
  try {
    return new Intl.DateTimeFormat(undefined, {
      timeZone: timeZone ?? undefined,
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(date);
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(date);
  }
};

/**
 * Maps a failed reply to its wording, by HTTP status — never by matching the
 * server's own message text, which is neither translated nor written for the
 * person reading it.
 */
const replyErrorKey = (error: unknown): StringKey => {
  if (error instanceof ApiError && error.status === 409) {
    return 'enquiry.reply.alreadyAnswered';
  }
  if (error instanceof ApiError && error.status === 404) {
    return 'enquiry.reply.gone';
  }
  return 'enquiry.reply.failed';
};

/**
 * The question an agent is waiting on, and the form that answers it.
 *
 * **A plain modal, not a parkable one** — the same reasoning as `TaskDialog`
 * (008.03): before the user starts typing there is nothing here they have
 * authored, and unlike the chat dialog there is nowhere useful to keep a
 * half-typed answer visible while minimised. There is no `onMinimise` here.
 *
 * **No `useEventStream` here, deliberately.** `ConversationDetailResponseDto`
 * carries the conversation's own `id` at the top level, and `CompanyPage`
 * already holds open `streamUrls.company(companyId)` — every event on it
 * patches the query cache this dialog reads (`applyEvent` matches a cached
 * row by its top-level `id`), so this dialog's data stays live without a
 * subscription of its own. Opening a second stream here would spend a
 * connection from the `MAX_STREAMS` budget for a value that is already kept
 * current.
 */
export const ResponseDialog = ({ slug, onClose }: ResponseDialogProps) => {
  const enquiry = useLiveEnquiryState(slug);
  const reply = useReplyToEnquiry(slug);

  const {
    data: enquiryData,
    isPending: enquiryPending,
    isError: enquiryFailed,
  } = enquiry;

  const detailsHeadingId = useId();
  const detailsRef = useRef<HTMLElement | null>(null);
  const sentRef = useRef<HTMLElement | null>(null);
  const replyInputRef = useRef<HTMLElement | null>(null);

  const [replyText, setReplyText] = useState('');
  const [fieldError, setFieldError] = useState<string | undefined>(undefined);

  const orderedMessages = useMemo(
    () =>
      [...(enquiryData?.messages ?? [])].sort((a, b) =>
        a.timestamp === b.timestamp
          ? a.id.localeCompare(b.id)
          : a.timestamp.localeCompare(b.timestamp),
      ),
    [enquiryData?.messages],
  );

  // A 409 means retrying cannot succeed — the conversation was answered
  // somewhere else — so the form comes down rather than staying live with a
  // Send button that can only fail the same way again.
  const alreadyAnswered =
    reply.isError &&
    reply.error instanceof ApiError &&
    reply.error.status === 409;
  const showForm = !reply.isSuccess && !alreadyAnswered;

  // ADR-027: a focused control that disappears must not leave focus on
  // `document.body`. The form vanishes on both outcomes here — a successful
  // reply moves focus to the confirmation message below, and a 409 falls back
  // to the question, the next readable thing in the dialog.
  useEffect(() => {
    if (showForm) return;
    if (document.activeElement !== document.body) return;
    (reply.isSuccess ? sentRef : detailsRef).current?.focus();
  }, [showForm, reply.isSuccess]);

  const handleSubmit = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault();

    if (replyText.trim() === '') {
      const message = t('enquiry.reply.required');
      setFieldError(message);
      focusFirstInvalid([{ error: message, ref: replyInputRef }]);
      return;
    }

    setFieldError(undefined);
    reply.mutate(replyText);
  };

  return (
    <Dialog
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      heading={
        enquiryData === undefined
          ? t('enquiry.dialog.heading.pending')
          : t('enquiry.dialog.heading', { role: enquiryData.roleName })
      }
    >
      {enquiryPending && <LoadingState label={t('enquiry.loading')} />}

      {enquiryFailed && (
        <ErrorState message={t('enquiry.error')} channel={`enquiry:${slug}`} />
      )}

      {enquiryData !== undefined && (
        <>
          <section
            className="response-dialog__details"
            aria-labelledby={detailsHeadingId}
            tabIndex={-1}
            ref={detailsRef}
          >
            <h3
              id={detailsHeadingId}
              className="response-dialog__details-heading"
            >
              {t('enquiry.question.label')}
            </h3>
            <p className="response-dialog__question">{enquiryData.question}</p>

            {enquiryData.context !== null && (
              <p className="response-dialog__field">
                <span className="response-dialog__field-label">
                  {t('enquiry.context.label')}
                </span>
                {enquiryData.context}
              </p>
            )}

            <h3 className="response-dialog__messages-heading">
              {t('enquiry.messages.label')}
            </h3>
            {orderedMessages.length === 0 ? (
              <EmptyState
                heading={t('enquiry.messages.empty.heading')}
                headingLevel={3}
              >
                <p>{t('enquiry.messages.empty.body')}</p>
              </EmptyState>
            ) : (
              <ol className="response-dialog__messages">
                {orderedMessages.map((message) => (
                  <li key={message.id} className="response-dialog__message">
                    <span className="response-dialog__message-author">
                      {message.author === 'user'
                        ? t('enquiry.message.author.user')
                        : t('enquiry.message.author.agent', {
                            role: enquiryData.roleName,
                          })}
                    </span>
                    <time
                      className="response-dialog__message-time"
                      dateTime={message.timestamp}
                    >
                      {formatTime(
                        message.timestamp,
                        enquiryData.companyTimezone,
                      )}
                    </time>
                    <p className="response-dialog__message-content">
                      {message.content}
                    </p>
                  </li>
                ))}
              </ol>
            )}
          </section>

          {reply.isSuccess ? (
            <p
              className="response-dialog__sent"
              tabIndex={-1}
              // A callback rather than the ref itself: this is a `p` and the
              // ref is the wider `HTMLElement` the focus helpers share, which
              // a typed `ref` prop will not accept without a cast.
              ref={(node) => {
                sentRef.current = node;
              }}
            >
              {t('enquiry.reply.sent')}
            </p>
          ) : (
            <>
              {showForm && (
                <form
                  className="response-dialog__reply"
                  onSubmit={handleSubmit}
                >
                  <TextField
                    multiline
                    isRequired
                    label={t('enquiry.reply.label')}
                    value={replyText}
                    onChange={setReplyText}
                    errorMessage={fieldError}
                    isDisabled={reply.isPending}
                    inputRef={replyInputRef}
                  />
                  <Button
                    type="submit"
                    className="react-aria-Button response-dialog__send"
                    isDisabled={reply.isPending}
                  >
                    {t('enquiry.reply.send')}
                  </Button>
                </form>
              )}

              {reply.isError && (
                <ErrorState
                  message={t(replyErrorKey(reply.error))}
                  channel={`enquiry-reply:${slug}`}
                />
              )}
            </>
          )}
        </>
      )}
    </Dialog>
  );
};
