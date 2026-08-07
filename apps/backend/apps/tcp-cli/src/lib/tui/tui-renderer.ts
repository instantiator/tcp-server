import type { WireEvent } from '@tcp/shared';
import { Renderer } from '../core/render';
import { Tui } from './tui';

/**
 * Adapts a {@link Tui} pane to the {@link Renderer} interface that
 * `session.ts`'s existing `streamAgent`/`runTurn` control flow already drives.
 *
 * This is what lets that flow stay unchanged between TUI and piped-output
 * modes: only which `Renderer` gets constructed differs.
 */
export function tuiRenderer(tui: Tui, paneId: string): Renderer {
  let responseSeen = false;
  return {
    render(event: WireEvent): void {
      if (event.type === 'stream' && event.channel === 'response') {
        responseSeen = true;
      }
      tui.appendEvent(paneId, event);
    },
    get responseSeen() {
      return responseSeen;
    },
    finish(): void {
      // Panes have no open-block state to flush; event-driven redraws already
      // reflect the latest content.
    },
  };
}
