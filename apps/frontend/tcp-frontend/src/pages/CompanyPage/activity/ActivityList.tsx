import { useId, type ReactNode } from 'react';
import { EmptyState } from '../../../components/EmptyState/EmptyState';
import { ErrorState } from '../../../components/ErrorState/ErrorState';
import { LoadingState } from '../../../components/LoadingState/LoadingState';
import { t } from '../../../strings';

/**
 * The state of the query behind a list.
 *
 * Structural rather than TanStack's own `UseQueryResult`: these three fields
 * are all a list frame needs, and naming them keeps the frame usable by
 * anything that can report them.
 */
export interface ActivityQuery {
  readonly isPending: boolean;
  readonly error: Error | null;
  readonly refetch: () => unknown;
}

export interface ActivityListProps {
  /**
   * An id for the outermost element, so a link elsewhere in the app (a
   * notification's `durableHref`) has a fragment to point at. Omit for a list
   * nothing links to directly.
   */
  readonly id?: string;
  /** The list's name, already resolved through `t`. */
  readonly heading: string;
  /**
   * Passed whole rather than as three separate props, so a list cannot wire
   * its own `isPending` to another's `error`.
   */
  readonly query: ActivityQuery;
  /** The announcer channel of this list; also the channel its errors report on. */
  readonly channel: string;
  /** How many rows `children` renders. Shown to everyone, not just assistive tech. */
  readonly count: number;
  readonly emptyHeading: string;
  readonly emptyBody: string;
  /** A standing caveat about what the list cannot show. Rendered above the rows. */
  readonly note?: string;
  /** Controls acting on this list, such as a filter. Rendered inside the region. */
  readonly controls?: ReactNode;
  /** The `<ul>` of rows, when there are any. */
  readonly children: ReactNode;
}

/**
 * The shared frame for the four activity lists.
 *
 * There is one component rather than four, because the four lists must not be
 * able to drift apart: the same loading, error, empty and populated states,
 * in the same order, with the same accessibility contract, are what let a
 * screen reader user learn the page once and then trust every list on it.
 *
 * `aria-busy` sits on the body div rather than on `LoadingState`, exactly as
 * `CompaniesPage` does it: ADR-027 marks the region whose content is loading
 * as busy, and `LoadingState` cannot know how much of the page it stands in
 * for — only the caller that placed it does.
 *
 * Each list gets its own `ActivityList`, so its own frame, so a list that
 * fails to load renders its `ErrorState` in place without disturbing the
 * other three. Failure isolation is structural here, not a behaviour any one
 * list has to implement.
 */
export const ActivityList = ({
  id,
  heading,
  query: { isPending, error, refetch },
  channel,
  count,
  emptyHeading,
  emptyBody,
  note,
  controls,
  children,
}: ActivityListProps) => {
  const headingId = useId();

  return (
    <section id={id} className="activity-list" aria-labelledby={headingId}>
      {/*
        `h2`: the page's `h1` is the company name and nothing sits between them,
        so this is the next level. Skipping to `h3` to reflect the tab frame's
        visual nesting would break the outline — the tab is not a heading.
      */}
      <h2 id={headingId} className="activity-list__heading">
        {heading}
      </h2>
      {/*
        Suppressed while loading or failed: "0 shown" is not the answer to how
        many there are, it is the absence of an answer, and stating it as a
        figure claims a certainty the page does not have yet.
      */}
      {!isPending && error === null && (
        <p className="activity-list__count">{t('activity.count', { count })}</p>
      )}
      {/*
        Inside the region, not beside it: a filter rendered as the region's
        sibling is tied to the list it filters by proximity alone, which is
        nothing a screen reader can convey. Outside the busy area below,
        because a control over the content is not part of it.
      */}
      {controls}
      {note !== undefined && (
        // Outside the busy region: this is a standing fact about the list,
        // not part of its loading content, so it stays visible through every
        // state below rather than disappearing while the list is fetching.
        <p className="activity-list__note">{note}</p>
      )}
      <div className="activity-list__body" aria-busy={isPending}>
        {isPending && <LoadingState label={t('activity.loading')} />}

        {!isPending && error !== null && (
          <ErrorState
            message={t('activity.error.failed')}
            channel={channel}
            onRetry={() => {
              void refetch();
            }}
          />
        )}

        {!isPending && error === null && count === 0 && (
          // `3`, explicit: this list's own heading is an `h2`.
          <EmptyState heading={emptyHeading} headingLevel={3}>
            <p>{emptyBody}</p>
          </EmptyState>
        )}

        {!isPending && error === null && count > 0 && children}
      </div>
    </section>
  );
};
