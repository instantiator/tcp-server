import { AUTO, Game, Scale } from 'phaser';
import { useEffect, useLayoutEffect, useRef } from 'react';
import { TcpCompanyScene } from './scene/TcpCompanyScene';
import type { HoverEvent, SelectionTarget } from './TcpPhaserEventBus';
import { emitTcpEvent, offTcpEvent, onTcpEvent } from './TcpPhaserEventBus';
import type { OfficeWorld, Tile } from './world/types';

export interface TcpPhaserVisualisationProps {
  readonly world: OfficeWorld;
  readonly reducedMotion?: boolean;
  readonly followTarget?: SelectionTarget | null;
  readonly onAvatarArrived?: (avatarId: string, tile: Tile) => void;
  readonly onAvatarExited?: (avatarId: string) => void;
  readonly onHover?: (hover: HoverEvent | null) => void;
  readonly onSelect?: (target: SelectionTarget) => void;
  readonly onFollowStopped?: () => void;
}

/**
 * Mounts the Phaser game and is the only React place that registers bus
 * listeners. Every listener reads its prop through a ref, so a new callback
 * identity never re-registers anything — only mount and unmount do, which is
 * what lets exactly one listener per event survive a React StrictMode double
 * mount.
 */
export default function TcpPhaserVisualisation({
  world,
  reducedMotion,
  followTarget,
  onAvatarArrived,
  onAvatarExited,
  onHover,
  onSelect,
  onFollowStopped,
}: TcpPhaserVisualisationProps) {
  const parentRef = useRef<HTMLDivElement | null>(null);
  const gameRef = useRef<Phaser.Game | null>(null);

  /** Always the latest {@link world}, read by the mount-time `scene-ready` handler. */
  const worldRef = useRef(world);
  worldRef.current = world;
  const reducedMotionRef = useRef(reducedMotion);
  reducedMotionRef.current = reducedMotion;
  const followTargetRef = useRef(followTarget);
  followTargetRef.current = followTarget;

  const onAvatarArrivedRef = useRef(onAvatarArrived);
  onAvatarArrivedRef.current = onAvatarArrived;
  const onAvatarExitedRef = useRef(onAvatarExited);
  onAvatarExitedRef.current = onAvatarExited;
  const onHoverRef = useRef(onHover);
  onHoverRef.current = onHover;
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const onFollowStoppedRef = useRef(onFollowStopped);
  onFollowStoppedRef.current = onFollowStopped;

  /** Game mount and unmount. Runs once; every prop change is handled below instead. */
  useLayoutEffect(() => {
    const parent = parentRef.current;
    if (parent === null) {
      return undefined;
    }

    const handleSceneReady = () => {
      emitTcpEvent({ event: 'world-changed', value: worldRef.current });
      emitTcpEvent({
        event: 'motion-preference',
        value: { reduced: reducedMotionRef.current ?? false },
      });
      emitTcpEvent({
        event: 'camera-follow',
        value: followTargetRef.current ?? null,
      });
    };
    const handleAvatarArrived = (value: { avatarId: string; tile: Tile }) => {
      onAvatarArrivedRef.current?.(value.avatarId, value.tile);
    };
    const handleAvatarExited = (value: { avatarId: string }) => {
      onAvatarExitedRef.current?.(value.avatarId);
    };
    const handleHover = (value: HoverEvent | null) => {
      onHoverRef.current?.(value);
    };
    const handleSelect = (value: SelectionTarget) => {
      onSelectRef.current?.(value);
    };
    const handleFollowStopped = () => {
      onFollowStoppedRef.current?.();
    };

    onTcpEvent({ event: 'scene-ready', fn: handleSceneReady });
    onTcpEvent({ event: 'avatar-arrived', fn: handleAvatarArrived });
    onTcpEvent({ event: 'avatar-exited', fn: handleAvatarExited });
    onTcpEvent({ event: 'hover', fn: handleHover });
    onTcpEvent({ event: 'select', fn: handleSelect });
    onTcpEvent({ event: 'follow-stopped', fn: handleFollowStopped });

    const game = new Game({
      type: AUTO,
      parent,
      transparent: true,
      scale: { mode: Scale.RESIZE, width: '100%', height: '100%' },
      // Phaser's keyboard plugin listens on `window`, which would steal
      // arrow keys from the page and from React Aria's own key handling.
      // Keyboard panning is React's job (a later step), on the focused stage.
      input: { keyboard: false },
      scene: [TcpCompanyScene],
    });
    gameRef.current = game;

    return () => {
      offTcpEvent({ event: 'scene-ready', fn: handleSceneReady });
      offTcpEvent({ event: 'avatar-arrived', fn: handleAvatarArrived });
      offTcpEvent({ event: 'avatar-exited', fn: handleAvatarExited });
      offTcpEvent({ event: 'hover', fn: handleHover });
      offTcpEvent({ event: 'select', fn: handleSelect });
      offTcpEvent({ event: 'follow-stopped', fn: handleFollowStopped });
      game.destroy(true);
      gameRef.current = null;
    };
  }, []);

  // Emitting before the scene has announced `scene-ready` is harmless: the
  // bus holds no state, so an event with nothing listening yet is simply lost,
  // and the mount-time handler above sends the current values as soon as it
  // is ready.
  useEffect(() => {
    emitTcpEvent({ event: 'world-changed', value: world });
  }, [world]);

  useEffect(() => {
    emitTcpEvent({
      event: 'motion-preference',
      value: { reduced: reducedMotion ?? false },
    });
  }, [reducedMotion]);

  useEffect(() => {
    emitTcpEvent({ event: 'camera-follow', value: followTarget ?? null });
  }, [followTarget]);

  return <div ref={parentRef} className="company-visualisation__canvas" />;
}
