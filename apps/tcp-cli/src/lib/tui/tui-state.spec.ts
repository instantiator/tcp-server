import {
  ListEntry,
  MultiListSelection,
  PaneManager,
  SelectableList,
} from './tui-state';

function entry(id: string, selectable = true): ListEntry {
  return { id, selectable, render: () => [id] };
}

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

describe('MultiListSelection', () => {
  function twoLists(): SelectableList[] {
    return [
      {
        title: 'Roles',
        groups: [{ entries: [entry('r1'), entry('r2')] }],
      },
      {
        title: 'Tasks',
        groups: [
          { title: 'Active', entries: [entry('t1'), entry('t2')] },
          { title: 'Done', entries: [entry('t3')] },
        ],
      },
    ];
  }

  it('starts at the first selectable row', () => {
    const sel = new MultiListSelection();
    sel.setLists(twoLists());
    expect(sel.current?.entry.id).toBe('r1');
  });

  it('moveSelection walks forward across group and list boundaries', () => {
    const sel = new MultiListSelection();
    sel.setLists(twoLists());
    sel.moveSelection(1);
    expect(sel.current?.entry.id).toBe('r2');
    sel.moveSelection(1);
    expect(sel.current?.entry.id).toBe('t1');
    sel.moveSelection(1);
    expect(sel.current?.entry.id).toBe('t2');
    sel.moveSelection(1);
    expect(sel.current?.entry.id).toBe('t3');
  });

  it('moveSelection cycles top↔bottom over the whole concatenated set', () => {
    const sel = new MultiListSelection();
    sel.setLists(twoLists());
    sel.moveSelection(-1);
    expect(sel.current?.entry.id).toBe('t3');
    sel.moveSelection(1);
    expect(sel.current?.entry.id).toBe('r1');
  });

  it('skips non-selectable rows (e.g. a group heading rendered as an entry)', () => {
    const lists: SelectableList[] = [
      {
        title: 'Tasks',
        groups: [{ entries: [entry('heading', false), entry('t1')] }],
      },
    ];
    const sel = new MultiListSelection();
    sel.setLists(lists);
    expect(sel.current?.entry.id).toBe('t1');
  });

  it('jumpToList moves to the first selectable entry of the next/previous list', () => {
    const sel = new MultiListSelection();
    sel.setLists(twoLists());
    sel.jumpToList(1);
    expect(sel.current?.entry.id).toBe('t1');
    sel.jumpToList(1);
    expect(sel.current?.entry.id).toBe('r1');
    sel.jumpToList(-1);
    expect(sel.current?.entry.id).toBe('t1');
  });

  it('jumpToList is a no-op with fewer than two lists', () => {
    const sel = new MultiListSelection();
    sel.setLists([twoLists()[0]]);
    sel.jumpToList(1);
    expect(sel.current?.entry.id).toBe('r1');
  });

  it('jumpToList skips a list with no selectable entries', () => {
    const lists: SelectableList[] = [
      { title: 'A', groups: [{ entries: [entry('a1')] }] },
      { title: 'B', groups: [{ entries: [] }] },
      { title: 'C', groups: [{ entries: [entry('c1')] }] },
    ];
    const sel = new MultiListSelection();
    sel.setLists(lists);
    sel.jumpToList(1);
    expect(sel.current?.entry.id).toBe('c1');
  });

  it('clamps the index when the list shrinks', () => {
    const sel = new MultiListSelection();
    sel.setLists(twoLists());
    sel.moveSelection(4); // -> t3 (last)
    sel.setLists([twoLists()[0]]); // shrink to just Roles (2 entries)
    expect(sel.current?.entry.id).toBe('r2');
  });

  it('current is undefined when there are no selectable rows at all', () => {
    const sel = new MultiListSelection();
    sel.setLists([{ title: 'Empty', groups: [{ entries: [] }] }]);
    expect(sel.current).toBeUndefined();
  });

  it('moveSelection/jumpToList are no-ops with no selectable rows', () => {
    const sel = new MultiListSelection();
    sel.setLists([{ title: 'Empty', groups: [{ entries: [] }] }]);
    expect(() => sel.moveSelection(1)).not.toThrow();
    expect(() => sel.jumpToList(1)).not.toThrow();
    expect(sel.current).toBeUndefined();
  });
});
