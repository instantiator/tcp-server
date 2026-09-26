import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { t } from '../../../strings';
import './CompanyVisualisation.css';
import { emitTcpEvent } from './TcpPhaserEventBus';
import type { HoverEvent, SelectionTarget } from './TcpPhaserEventBus';
import TcpPhaserVisualisation from './TcpPhaserVisualisation';
import { PAN_STEP_PX, VisualisationToolbar } from './ui/VisualisationToolbar';
import { VisualisationTooltip } from './ui/VisualisationTooltip';
import { VisualisationTray } from './ui/VisualisationTray';
import { useFullscreen } from './useFullscreen';
import { useOfficeWorld } from './useOfficeWorld';
import { useReducedMotion } from './useReducedMotion';

export interface CompanyVisualisationProps {
  readonly companyId: string;
}

/** Whether `a` and `b` name the same role, task or agent. */
const sameTarget = (
  a: SelectionTarget | null,
  b: SelectionTarget | null,
): boolean => a !== null && b !== null && a.kind === b.kind && a.id === b.id;

/**
 * The company's office, drawn as an isometric scene. `useOfficeWorld` turns
 * the company's live roles, agents, tasks, assignments and enquiries into an
 * office world; `TcpPhaserVisualisation` draws it and reports back hover,
 * selection, arrival and departure over the bus.
 *
 * This component owns everything a keyboard or screen-reader user needs that
 * the canvas alone can't give them: the toolbar (pan, full screen, the
 * details picker), the hover tooltip, the selection tray, and the keys that
 * pan the stage. `DetailsPicker` doubles as the keyboard route to a
 * selection (WCAG 2.1.1) — hovering and clicking the canvas directly is the
 * pointer route, not the only one.
 */
export default function CompanyVisualisation({
  companyId,
}: CompanyVisualisationProps) {
  const { world, snapshot, avatarArrived, avatarExited } =
    useOfficeWorld(companyId);
  const summaryId = useId();
  const keysId = useId();
  const reducedMotion = useReducedMotion();

  const containerRef = useRef<HTMLElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const { isFullscreen, toggle } = useFullscreen(containerRef);

  const [selection, setSelection] = useState<SelectionTarget | null>(null);
  const [hover, setHover] = useState<HoverEvent | null>(null);
  const [following, setFollowing] = useState(false);
  /** The target a tooltip was showing for when Escape last dismissed it. */
  const [dismissedHover, setDismissedHover] = useState<SelectionTarget | null>(
    null,
  );

  const roles = world.avatars.filter((avatar) => avatar.kind === 'role').length;
  const taskRooms = world.rooms.filter(
    (room) => room.purpose === 'task',
  ).length;
  const agents = world.avatars.filter(
    (avatar) => avatar.kind === 'agent',
  ).length;
  const summary = t('visualisation.summary', { roles, taskRooms, agents });

  const select = useCallback((target: SelectionTarget) => {
    setSelection(target);
    setFollowing(false);
  }, []);

  const pan = useCallback((dx: number, dy: number) => {
    emitTcpEvent({ event: 'camera-pan', value: { dx, dy } });
  }, []);

  const followTarget = following && selection !== null ? selection : null;

  // A dismissed tooltip is keyed by *target*, not by the hover event object —
  // a `pointermove` over the same target keeps arriving as a new event, and
  // that must not bring the tooltip back. Only a different target, or no
  // target at all, does.
  const shownHover =
    hover !== null && sameTarget(hover.target, dismissedHover) ? null : hover;

  useEffect(() => {
    if (shownHover === null) {
      return undefined;
    }
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setDismissedHover(shownHover.target);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [shownHover]);

  const onStageKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.ctrlKey || event.metaKey || event.altKey) {
        return;
      }
      switch (event.key) {
        case 'ArrowLeft':
        case 'a':
        case 'A':
          event.preventDefault();
          pan(-PAN_STEP_PX, 0);
          break;
        case 'ArrowRight':
        case 'd':
        case 'D':
          event.preventDefault();
          pan(PAN_STEP_PX, 0);
          break;
        case 'ArrowUp':
        case 'w':
        case 'W':
          event.preventDefault();
          pan(0, -PAN_STEP_PX);
          break;
        case 'ArrowDown':
        case 's':
        case 'S':
          event.preventDefault();
          pan(0, PAN_STEP_PX);
          break;
        default:
          break;
      }
    },
    [pan],
  );

  const onStageDoubleClick = useCallback(() => {
    if (hover === null) {
      toggle();
    }
  }, [hover, toggle]);

  const closeTray = useCallback(() => {
    setSelection(null);
    setFollowing(false);
    // The deliberate focus target (ADR-027): never leave focus on
    // `document.body` once the element it was on disappears.
    stageRef.current?.focus();
  }, []);

  return (
    <section ref={containerRef} className="company-visualisation">
      <VisualisationToolbar
        snapshot={snapshot}
        selection={selection}
        onSelect={select}
        onPan={pan}
        isFullscreen={isFullscreen}
        onToggleFullscreen={toggle}
      />
      <div className="company-visualisation__main">
        {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- the stage is a labelled pan surface; its toolbar buttons are the non-pointer route (ADR-026) */}
        <div
          ref={stageRef}
          className="company-visualisation__stage"
          role="group"
          aria-label={t('visualisation.stage.label')}
          aria-describedby={`${summaryId} ${keysId}`}
          // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- the stage is a labelled pan surface; its toolbar buttons are the non-pointer route (ADR-026)
          tabIndex={0}
          onKeyDown={onStageKeyDown}
          onDoubleClick={onStageDoubleClick}
        >
          <TcpPhaserVisualisation
            world={world}
            reducedMotion={reducedMotion}
            followTarget={followTarget}
            onAvatarArrived={avatarArrived}
            onAvatarExited={avatarExited}
            onHover={setHover}
            onSelect={select}
            onFollowStopped={() => {
              setFollowing(false);
            }}
          />
          <VisualisationTooltip hover={shownHover} snapshot={snapshot} />
        </div>
        {selection !== null && (
          <VisualisationTray
            companyId={companyId}
            selection={selection}
            following={following}
            onToggleFollow={() => {
              setFollowing((f) => !f);
            }}
            onClose={closeTray}
          />
        )}
      </div>
      <p id={summaryId} className="visually-hidden">
        {summary}
      </p>
      <p id={keysId} className="visually-hidden">
        {t('visualisation.keys')}
      </p>
    </section>
  );
}
