import { Focusable, Tooltip, TooltipTrigger } from 'react-aria-components';
import { t } from '../../strings';
import type { SpendBarTone } from './spend-bar-model';
import './SpendBar.css';

export interface SpendBarProps {
  /** May exceed 100 (a reached cap); the meter itself clamps its fill. */
  readonly percent: number;
  readonly tone: SpendBarTone;
  /** The meter's `aria-valuetext` — the words a screen reader says instead of a bare number. */
  readonly valueText: string;
  /** The tooltip's lines, one per provider or limit. */
  readonly details: readonly string[];
}

/**
 * A breadcrumb crumb's thin usage meter (000.02): full for an uncapped total,
 * or progress against the highest-percentage configured limit.
 *
 * A plain `role="meter"` element rather than React Aria's `Meter`, because the
 * meter must itself be the keyboard-focusable tooltip trigger (WCAG 1.4.13),
 * and `Focusable` only accepts a host element. `Meter` would also render
 * `role="meter progressbar"`, which axe-core misreads as one unknown role.
 */
export const SpendBar = ({
  percent,
  tone,
  valueText,
  details,
}: SpendBarProps) => {
  const clamped = Math.min(percent, 100);

  return (
    <TooltipTrigger>
      <Focusable>
        <div
          className={`spend-bar spend-bar--${tone}`}
          role="meter"
          aria-label={t('spend.bar.label')}
          aria-valuenow={clamped}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuetext={valueText}
        >
          <div
            className="spend-bar__fill"
            style={{ inlineSize: `${clamped}%` }}
          />
        </div>
      </Focusable>
      <Tooltip className="react-aria-Tooltip spend-bar__tooltip">
        {details.map((line, index) => (
          <div key={index}>{line}</div>
        ))}
      </Tooltip>
    </TooltipTrigger>
  );
};

/**
 * Holds a {@link SpendBar}'s space while its data loads or has failed, so the
 * layout below doesn't move when the real bar arrives — the office view
 * sizes its canvas from where it starts. Hidden from assistive technology:
 * there is no value to announce yet.
 */
export const SpendBarPlaceholder = () => (
  <span className="spend-bar spend-bar--placeholder" aria-hidden="true" />
);
