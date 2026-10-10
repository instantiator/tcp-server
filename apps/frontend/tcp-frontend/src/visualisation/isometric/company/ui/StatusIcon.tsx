import {
  Ban,
  CircleCheck,
  CirclePause,
  CirclePlay,
  CircleX,
  Hourglass,
  type LucideIcon,
} from 'lucide-react';
import { statusLabel } from '../../../../api/statuses';

/** Task and assignment statuses as icons; anything unlisted reads as working. */
const ICONS: Record<string, LucideIcon> = {
  ready: Hourglass,
  paused: CirclePause,
  succeeded: CircleCheck,
  failed: CircleX,
  cancelled: Ban,
};

/**
 * A task's or assignment's status as an icon (000.06.03). It is a named image,
 * not decoration: in the office tray it stands in for the status text, so its
 * name is the status ("In progress"), read before the text it sits beside.
 * A paused task shows as paused whatever its own status says.
 */
export const StatusIcon = ({
  status,
  paused = false,
}: {
  readonly status: string;
  readonly paused?: boolean;
}) => {
  const shown = paused ? 'paused' : status;
  const Glyph = ICONS[shown] ?? CirclePlay;
  return (
    <Glyph
      className="tcp-icon tray-status-icon"
      role="img"
      aria-label={statusLabel(shown)}
      aria-hidden={false}
    />
  );
};
