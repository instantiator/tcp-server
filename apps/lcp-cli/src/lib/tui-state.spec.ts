import { PaneManager } from './tui-state';

describe('PaneManager', () => {
  it('focuses the first pane added automatically', () => {
    const mgr = new PaneManager();
    mgr.addPane({ id: 'root', label: 'chicken', talkable: true });
    expect(mgr.activePane?.id).toBe('root');
  });

  it('does not change focus when a later pane is added', () => {
    const mgr = new PaneManager();
    mgr.addPane({ id: 'root', label: 'chicken', talkable: true });
    mgr.addPane({ id: 'cat', label: 'cat', talkable: false });
    expect(mgr.activePane?.id).toBe('root');
  });

  it('ignores a duplicate id', () => {
    const mgr = new PaneManager();
    mgr.addPane({ id: 'root', label: 'chicken', talkable: true });
    mgr.addPane({ id: 'root', label: 'renamed', talkable: false });
    expect(mgr.panesInOrder).toHaveLength(1);
    expect(mgr.panesInOrder[0].label).toBe('chicken');
  });

  it('input is enabled only for a talkable active pane', () => {
    const mgr = new PaneManager();
    mgr.addPane({ id: 'root', label: 'chicken', talkable: true });
    mgr.addPane({ id: 'cat', label: 'cat', talkable: false });
    expect(mgr.inputEnabled).toBe(true);
    mgr.switchTo('cat');
    expect(mgr.inputEnabled).toBe(false);
  });

  it('switchTo a non-existent id is a no-op', () => {
    const mgr = new PaneManager();
    mgr.addPane({ id: 'root', label: 'chicken', talkable: true });
    mgr.switchTo('nope');
    expect(mgr.activePane?.id).toBe('root');
  });

  it('next() cycles through panes and wraps around', () => {
    const mgr = new PaneManager();
    mgr.addPane({ id: 'a', label: 'a', talkable: true });
    mgr.addPane({ id: 'b', label: 'b', talkable: false });
    mgr.addPane({ id: 'c', label: 'c', talkable: false });
    mgr.next();
    expect(mgr.activePane?.id).toBe('b');
    mgr.next();
    expect(mgr.activePane?.id).toBe('c');
    mgr.next();
    expect(mgr.activePane?.id).toBe('a');
  });

  it('prev() cycles backwards and wraps around', () => {
    const mgr = new PaneManager();
    mgr.addPane({ id: 'a', label: 'a', talkable: true });
    mgr.addPane({ id: 'b', label: 'b', talkable: false });
    mgr.prev();
    expect(mgr.activePane?.id).toBe('b');
    mgr.prev();
    expect(mgr.activePane?.id).toBe('a');
  });

  it('next()/prev() are no-ops with no panes', () => {
    const mgr = new PaneManager();
    expect(() => mgr.next()).not.toThrow();
    expect(() => mgr.prev()).not.toThrow();
    expect(mgr.activePane).toBeNull();
  });

  it('removing the active pane focuses the pane that took its slot, or the previous one if it was last', () => {
    const mgr = new PaneManager();
    mgr.addPane({ id: 'a', label: 'a', talkable: true });
    mgr.addPane({ id: 'b', label: 'b', talkable: false });
    mgr.addPane({ id: 'c', label: 'c', talkable: false });
    mgr.switchTo('b');
    mgr.removePane('b');
    expect(mgr.activePane?.id).toBe('c');
    expect(mgr.panesInOrder.map((p) => p.id)).toEqual(['a', 'c']);

    mgr.switchTo('c');
    mgr.removePane('c');
    expect(mgr.activePane?.id).toBe('a');
  });

  it('removing a non-active pane leaves focus unchanged', () => {
    const mgr = new PaneManager();
    mgr.addPane({ id: 'a', label: 'a', talkable: true });
    mgr.addPane({ id: 'b', label: 'b', talkable: false });
    mgr.removePane('b');
    expect(mgr.activePane?.id).toBe('a');
  });

  it('removing the last remaining pane leaves no active pane', () => {
    const mgr = new PaneManager();
    mgr.addPane({ id: 'a', label: 'a', talkable: true });
    mgr.removePane('a');
    expect(mgr.activePane).toBeNull();
    expect(mgr.inputEnabled).toBe(false);
  });

  it('removing a non-existent id is a no-op', () => {
    const mgr = new PaneManager();
    mgr.addPane({ id: 'a', label: 'a', talkable: true });
    expect(() => mgr.removePane('nope')).not.toThrow();
    expect(mgr.panesInOrder).toHaveLength(1);
  });
});
