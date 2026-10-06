import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { t } from '../../strings';
import './Breadcrumbs.css';

/** One step in the trail. The last crumb has no destination — it is here. */
export interface Crumb {
  label: string;
  to?: string;
  /** Rendered under the crumb's label, inside the same `li` (000.02: spend bars). */
  bar?: ReactNode;
}

/**
 * Where the user is, and the way back up (WCAG 2.4.8, adopted by ADR-026).
 *
 * Built from `nav`/`ol`/`li` rather than React Aria's `Breadcrumbs`, which is
 * the one place in this application where the library earns nothing: a
 * breadcrumb has no keyboard behaviour to inherit, and React Aria supplies
 * `aria-current="page"` only through its own `Link` component — adopting it
 * would mean adopting React Aria's `RouterProvider` too, to stop those links
 * doing full page loads. Four lines of native markup against a router-wide
 * integration.
 *
 * Used by the company page (006.01) to show the way back to the companies
 * list. `bar` (000.02) carries a crumb's spend meter, rendered under its
 * label inside the same `li` — a spend bar is about *that* crumb's scope
 * (the application, or one company), not a separate trail item.
 */
export const Breadcrumbs = ({ items }: { items: readonly Crumb[] }) => (
  <nav className="breadcrumbs" aria-label={t('breadcrumbs.label')}>
    <ol className="breadcrumbs__list">
      {items.map((item) => (
        <li className="breadcrumbs__item" key={item.label}>
          {item.to === undefined ? (
            <span aria-current="page">{item.label}</span>
          ) : (
            <Link to={item.to}>{item.label}</Link>
          )}
          {item.bar}
        </li>
      ))}
    </ol>
  </nav>
);
