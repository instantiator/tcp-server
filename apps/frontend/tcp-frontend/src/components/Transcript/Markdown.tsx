import { memo, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';

/** Every heading level an agent writes lands below the chat view's own `h3`. */
const Heading = ({ children }: { readonly children?: ReactNode }) => (
  <h4 className="transcript__markdown-heading">{children}</h4>
);

/**
 * How agent markdown maps to elements. The text is model output, so:
 * - images show their alt text only: a remote image URL is how a prompt
 *   injection leaks data, and it would load without anyone choosing it;
 * - links open in a new tab and carry no opener or referrer;
 * - headings are all `h4`, so they never break the dialog's outline (ADR-027);
 * - tables scroll inside their own box rather than widening the view.
 * Raw HTML is never rendered: `react-markdown` drops it by default.
 */
const COMPONENTS: Components = {
  h1: Heading,
  h2: Heading,
  h3: Heading,
  h4: Heading,
  h5: Heading,
  h6: Heading,
  img: ({ alt }) =>
    alt === undefined || alt === '' ? null : <span>{alt}</span>,
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
  table: ({ children }) => (
    <div className="transcript__table-scroll">
      <table>{children}</table>
    </div>
  ),
};

const PLUGINS = [remarkGfm, remarkBreaks];

/**
 * A transcript entry's text as markdown, single newlines kept as line breaks.
 *
 * Memoised on the text: a streaming transcript re-renders on every delta, and
 * only the entry still growing needs parsing again. Half-written markup shows
 * as plain text until it closes.
 */
export const Markdown = memo(({ text }: { readonly text: string }) => (
  <div className="transcript__text transcript__markdown">
    <ReactMarkdown remarkPlugins={PLUGINS} components={COMPONENTS}>
      {text}
    </ReactMarkdown>
  </div>
));

Markdown.displayName = 'Markdown';
