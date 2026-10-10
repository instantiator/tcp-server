import type { LucideIcon } from 'lucide-react';
import { Button } from 'react-aria-components';
import { Icon, WithTooltip } from '../Icon/Icon';

export interface RoundIconButtonProps {
  readonly icon: LucideIcon;
  /** The accessible name and tooltip, already resolved through `t`. */
  readonly label: string;
  readonly onPress: () => void;
  /** Outlined rather than filled, for a secondary control. */
  readonly outline?: boolean;
  readonly isDisabled?: boolean;
  /** An extra class for the caller's own layout. */
  readonly className?: string;
  /** Where the tooltip is portalled; see `WithTooltip`. */
  readonly portalContainer?: Element | undefined;
}

/**
 * A small round icon button with its name as a tooltip: close, minimise,
 * complete, add. The name must say what the button does to what ("Close the
 * chat with Ann"), because an icon alone says nothing to a screen reader and
 * several identical names on one screen fail WCAG 2.4.6.
 */
export const RoundIconButton = ({
  icon,
  label,
  onPress,
  outline = false,
  isDisabled,
  className,
  portalContainer,
}: RoundIconButtonProps) => (
  <WithTooltip label={label} portalContainer={portalContainer}>
    <Button
      className={[
        'react-aria-Button tcp-icon-button tcp-icon-button--small',
        outline && 'tcp-button--outline',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      aria-label={label}
      isDisabled={isDisabled}
      onPress={onPress}
    >
      <Icon icon={icon} />
    </Button>
  </WithTooltip>
);
