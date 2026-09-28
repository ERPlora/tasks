// tasks#45 — on a phone, «Complete» on a card of «My tasks» made the card VANISH: the tab only lists
// OPEN tasks, so the reload after the command dropped it, the next card slid into its slot and the
// person could think they had closed a different task. Nothing said the action had worked.
//
// The convention (Things, Apple Reminders, Asana «My tasks», Odoo To-do): the task you just ticked
// stays where it was, shown as done, until you leave the view; and the action is confirmed (Todoist,
// Google Tasks). The «All» tab already kept its row — it lists closed tasks too — but confirmed nothing.
import { beforeEach, describe, expect, it } from 'vitest';
import esLocale from '../locales/es.json';
import enLocale from '../locales/en.json';

const ME = 'u-me';

type Task = Record<string, unknown> & { id: string; status: string };

const task = (id: string, title: string): Task => ({
  id,
  task_number: `TSK-${id}`,
  title,
  description: '',
  project_id: null,
  status: 'todo',
  priority: 'medium',
  assigned_to_ref: ME,
  created_by_ref: null,
  due_date: null,
  completed_at: null,
  parent_task_id: null,
  tags: '',
  created_at: '2026-09-26T09:00:00Z',
});

/** The server: every task in «My tasks» order, and the status each one has now. */
let tasks: Task[] = [];
let refuse: string | null = null;
let notices: { type: string; message: string }[] = [];
let listeners: Record<string, Array<() => void>> = {};

beforeEach(() => {
  tasks = [task('a', 'Restock shampoo'), task('b', 'Call the supplier'), task('c', 'Count the petty cash'), task('d', 'Order towels')];
  refuse = null;
  notices = [];
  listeners = {};
  localStorage.clear();
  localStorage.setItem('erplora.session', JSON.stringify({ id: ME, name: 'Me' }));
  (globalThis as Record<string, unknown>).erplora = {
    // tasks.tasks.my — OPEN tasks only, like queries/my_tasks.sql.
    query: async (name: string, params?: Record<string, unknown>) => {
      if (name === 'tasks.tasks.my') {
        return tasks.filter((t) => t.status !== 'done' && t.status !== 'cancelled').map((t) => ({ ...t }));
      }
      if (name === 'tasks.tasks.get') return tasks.filter((t) => t.id === params?.task_id).map((t) => ({ ...t }));
      return [];
    },
    queryPage: async () => ({ rows: tasks.map((t) => ({ ...t })), total: tasks.length }),
    command: async (name: string, payload: Record<string, unknown>) => {
      if (refuse) throw new Error(refuse);
      const row = tasks.find((t) => t.id === payload.task_id);
      if (row && name === 'tasks.tasks.complete') row.status = 'done';
      if (row && name === 'tasks.tasks.update_status') row.status = String(payload.new_status);
      return {};
    },
    on: (event: string, cb: () => void) => {
      (listeners[event] ??= []).push(cb);
      return () => {};
    },
    notify: (n: { type: string; message: string }) => notices.push(n),
    locale: 'en',
    t: (_c: unknown, key: string) => key,
  };
});

type Wc = HTMLElement & { shadowRoot: ShadowRoot; updateComplete: Promise<unknown> } & Record<string, any>;

async function settle(el: Wc): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await el.updateComplete;
    await new Promise((r) => setTimeout(r, 0));
  }
}

async function mountMine(): Promise<Wc> {
  await import('./components/erp-tasks-list/erp-tasks-list');
  const el = document.createElement('erp-tasks-list') as Wc;
  document.body.appendChild(el);
  await settle(el);
  el.setView('mine');
  await settle(el);
  return el;
}

async function rowAction(el: Wc, actionId: string, id: string): Promise<void> {
  const row = (el.shadowRoot.querySelector('ok-data-table') as unknown as { rows: Task[] }).rows.find((r) => r.id === id);
  expect(row, `card ${id} is on screen`).toBeTruthy();
  await el.onRowAction({ detail: { actionId, row } } as CustomEvent);
  await settle(el);
}

/** What the table of the active tab paints, card by card: id and status. */
const onScreen = (el: Wc): string[] =>
  (el.shadowRoot.querySelector('ok-data-table') as unknown as { rows: Task[] }).rows.map((r) => `${r.id}:${r.status}`);

describe('«My tasks» — the card just completed stays in its slot (tasks#45)', () => {
  it('keeps the completed card where it was, shown as done, instead of sliding the next one in', async () => {
    const el = await mountMine();
    expect(onScreen(el)).toEqual(['a:todo', 'b:todo', 'c:todo', 'd:todo']);

    await rowAction(el, 'complete', 'b');

    expect(onScreen(el)).toEqual(['a:todo', 'b:done', 'c:todo', 'd:todo']);
  });

  it('keeps the first and the last card in their slots too', async () => {
    const el = await mountMine();
    await rowAction(el, 'complete', 'a');
    await rowAction(el, 'complete', 'd');
    expect(onScreen(el)).toEqual(['a:done', 'b:todo', 'c:todo', 'd:done']);
  });

  it('keeps two neighbours completed one after the other in order', async () => {
    const el = await mountMine();
    await rowAction(el, 'complete', 'b');
    await rowAction(el, 'complete', 'c');
    expect(onScreen(el)).toEqual(['a:todo', 'b:done', 'c:done', 'd:todo']);
  });

  it('survives the live refresh a domain event triggers', async () => {
    const el = await mountMine();
    await rowAction(el, 'complete', 'b');
    for (const cb of listeners['tasks.task.completed'] ?? []) cb();
    await settle(el);
    expect(onScreen(el)).toEqual(['a:todo', 'b:done', 'c:todo', 'd:todo']);
  });

  it('lets it go once the person leaves the tab and comes back', async () => {
    const el = await mountMine();
    await rowAction(el, 'complete', 'b');
    el.setView('all');
    await settle(el);
    el.setView('mine');
    await settle(el);
    expect(onScreen(el)).toEqual(['a:todo', 'c:todo', 'd:todo']);
  });

  it('shows the server row, once, if the task is reopened meanwhile', async () => {
    const el = await mountMine();
    await rowAction(el, 'complete', 'b');
    tasks.find((t) => t.id === 'b')!.status = 'in_progress';
    await el.loadMyTasks();
    await settle(el);
    expect(onScreen(el)).toEqual(['a:todo', 'b:in_progress', 'c:todo', 'd:todo']);
  });

  it('keeps nothing when the hub refuses the completion', async () => {
    const el = await mountMine();
    refuse = 'A manager has to approve this.';
    await rowAction(el, 'complete', 'b');
    expect(onScreen(el)).toEqual(['a:todo', 'b:todo', 'c:todo', 'd:todo']);
    expect(el.pageError).toBe('A manager has to approve this.');
    expect(notices.filter((n) => n.type === 'success')).toEqual([]);
    // Nothing was kept: when the task later leaves «My tasks» for another reason (someone cancels
    // it), the next reload drops it instead of painting it back as done.
    tasks.find((t) => t.id === 'b')!.status = 'cancelled';
    await el.loadMyTasks();
    await settle(el);
    expect(onScreen(el)).toEqual(['a:todo', 'c:todo', 'd:todo']);
  });
});

describe('a row action says it worked (tasks#45)', () => {
  it('confirms «Complete» from a card of «My tasks»', async () => {
    const el = await mountMine();
    await rowAction(el, 'complete', 'b');
    expect(notices).toEqual([{ type: 'success', message: 'ui.taskCompleted' }]);
  });

  it('confirms «Complete» and «Start» from the «All» tab', async () => {
    await import('./components/erp-tasks-list/erp-tasks-list');
    const el = document.createElement('erp-tasks-list') as Wc;
    document.body.appendChild(el);
    await settle(el);
    await rowAction(el, 'start', 'a');
    await rowAction(el, 'complete', 'c');
    expect(notices).toEqual([
      { type: 'success', message: 'ui.taskStarted' },
      { type: 'success', message: 'ui.taskCompleted' },
    ]);
  });

  it('has both sentences in English and Spanish, and they are not the same one', () => {
    const en = (enLocale as { ui: Record<string, string> }).ui;
    const es = (esLocale as { ui: Record<string, string> }).ui;
    for (const key of ['taskCompleted', 'taskStarted']) {
      expect(en[key]?.trim(), `en ui.${key}`).toBeTruthy();
      expect(es[key]?.trim(), `es ui.${key}`).toBeTruthy();
      expect(es[key], `es ui.${key} is translated`).not.toBe(en[key]);
    }
    expect(en.taskCompleted).not.toBe(en.taskStarted);
    expect(es.taskCompleted).not.toBe(es.taskStarted);
  });
});

describe('a card only offers what can still be done to it (tasks#45)', () => {
  type Action = { id: string; hidden?: (r: Task) => boolean; disabled?: (r: Task) => boolean };
  /** The row actions a card offers: hidden ones are not painted (outfitkit ≥ 0.1.84), disabled
   *  ones cannot be pressed (older shells) — either way the person cannot run them. */
  const offered = (el: Wc, row: Task): string[] =>
    ((el.shadowRoot.querySelector('ok-data-table') as unknown as { actions: Action[] }).actions)
      .filter((a) => a.hidden?.(row) !== true && a.disabled?.(row) !== true)
      .map((a) => a.id);

  it('the card kept as done in «My tasks» no longer offers «Start» or «Complete»', async () => {
    const el = await mountMine();
    await rowAction(el, 'complete', 'b');
    const kept = (el.shadowRoot.querySelector('ok-data-table') as unknown as { rows: Task[] }).rows.find((r) => r.id === 'b')!;
    expect(kept.status).toBe('done');
    expect(offered(el, kept)).toEqual(['detail']);
  });

  it('follows the status: to do or blocked → start and complete; in progress → complete; closed → only the detail', async () => {
    const el = await mountMine();
    expect(offered(el, { ...task('x', 'x'), status: 'todo' })).toEqual(['detail', 'start', 'complete']);
    expect(offered(el, { ...task('x', 'x'), status: 'blocked' })).toEqual(['detail', 'start', 'complete']);
    expect(offered(el, { ...task('x', 'x'), status: 'in_progress' })).toEqual(['detail', 'complete']);
    expect(offered(el, { ...task('x', 'x'), status: 'done' })).toEqual(['detail']);
    expect(offered(el, { ...task('x', 'x'), status: 'cancelled' })).toEqual(['detail']);
  });
});
