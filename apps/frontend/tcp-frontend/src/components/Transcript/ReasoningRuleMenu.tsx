import { Brain } from 'lucide-react';
import {
  Button,
  Menu,
  MenuItem,
  MenuTrigger,
  Popover,
} from 'react-aria-components';
import { t, type StringKey } from '../../strings';
import { Icon, WithTooltip } from '../Icon/Icon';
import {
  REASONING_RULES,
  setReasoningRule,
  useReasoningRule,
  type ReasoningRule,
} from './reasoningRule';

const RULE_LABELS: Record<ReasoningRule, StringKey> = {
  all: 'transcript.reasoning.all',
  none: 'transcript.reasoning.none',
  latest: 'transcript.reasoning.latest',
};

/**
 * Chooses which reasoning entries start open, for every transcript.
 *
 * A menu of three checkable items rather than a button that cycles: a cycling
 * button's name would have to change under the user's finger, and its next
 * state can't be heard before pressing it.
 */
export const ReasoningRuleMenu = ({
  portalContainer,
}: {
  readonly portalContainer?: Element | undefined;
}) => {
  const rule = useReasoningRule();
  // A fixed name: the current rule is heard as the checked item in the menu.
  const label = t('transcript.reasoning.label');
  return (
    <MenuTrigger>
      <WithTooltip label={label} portalContainer={portalContainer}>
        <Button
          className="react-aria-Button tcp-icon-button tcp-icon-button--small tcp-button--outline"
          aria-label={label}
        >
          <Icon icon={Brain} />
        </Button>
      </WithTooltip>
      {/* eslint-disable-next-line @typescript-eslint/no-deprecated -- deliberate; see `WithTooltip` */}
      <Popover UNSTABLE_portalContainer={portalContainer}>
        <Menu
          selectionMode="single"
          selectedKeys={[rule]}
          disallowEmptySelection
          onSelectionChange={(keys) => {
            const [next] = [...(keys === 'all' ? [] : keys)];
            const chosen = REASONING_RULES.find((r) => r === next);
            if (chosen !== undefined) setReasoningRule(chosen);
          }}
        >
          {REASONING_RULES.map((option) => (
            <MenuItem key={option} id={option}>
              {t(RULE_LABELS[option])}
            </MenuItem>
          ))}
        </Menu>
      </Popover>
    </MenuTrigger>
  );
};
