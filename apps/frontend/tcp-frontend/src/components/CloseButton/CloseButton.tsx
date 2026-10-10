import { X } from 'lucide-react';
import {
  RoundIconButton,
  type RoundIconButtonProps,
} from '../RoundIconButton/RoundIconButton';

/** The one close control: a small round ✕, so every panel, dialog and notice closes the same way. */
export const CloseButton = (props: Omit<RoundIconButtonProps, 'icon'>) => (
  <RoundIconButton icon={X} {...props} />
);
