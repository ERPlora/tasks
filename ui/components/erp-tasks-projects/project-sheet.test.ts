// tasks#43 — on a phone, Tasks › Projects paints each project as a card, and tapping the card did
// NOTHING: no row click, no action icon, no way to open, edit or retire a project once created (the
// desktop row had none either). The Tasks tab next door opens its card.
//
// The convention (Odoo Project, Asana, Todoist, Monday): tapping a project opens it — its data,
// editable in place, the switch to take it out of use, and the tasks that belong to it, with a
// quick «add a task here». That is what this pins:
//
//   · the card is clickable AND carries a visible «Open» action, like the Tasks cards;
//   · the sheet shows the project READ FROM THE SERVER (never the row object the table handed over:
//     rv-payment_gateways-45), and the tasks filtered by `project_id`;
//   · Save / Deactivate / Activate go through `tasks.projects.update`, a refusal stays inside the
//     sheet with the sheet open, and the list is re-read afterwards;
//   · opening another project never paints the previous one's tasks (rv-invoice-126);
//   · loading / empty / error states of the project's tasks;
//   · every string the sheet paints exists in `en` AND `es`.
import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import esLocale from '../../../locales/es.json';
import enLocale from '../../../locales/en.json';

type Row = Record<string, unknown> & { id: string };

let projects: Row[] = [];
let tasks: Row[] = [];
let commands: { name: string; payload: Record<string, unknown> }[] = [];
let refuse: string | null = null;
let failTasksLoad = false;
/** When set, the tasks query for that project waits for this promise before answering. */
let holdTasksFor: { projectId: string; gate: Promise<void> } | null = null;
let listeners: Record<string, Array<() => void>> = {};
let listQueries: { name: string; params: Record<string, any> }[] = [];
/** When set, the tasks query reports this many matching tasks (a project bigger than one page). */
let tasksTotal: number | null = null;

beforeEach(() => {
  projects = [
    { id: 'p1', code: 'q3-audit', name: 'Q3 audit', color: '#ff0000', is_active: 1 },
    { id: 'p2', code: 'salon', name: 'Salon refit', color: '', is_active: 1 },
  ];
  tasks = [
    { id: 't1', task_number: 'TSK-1', title: 'Count stock', status: 'todo', project_id: 'p1' },
    { id: 't2', task_number: 'TSK-2', title: 'Paint walls', status: 'done', project_id: 'p2' },
    { id: 't3', task_number: 'TSK-3', title: 'Loose task', status: 'todo', project_id: null },
  ];
  commands = [];
  refuse = null;
  failTasksLoad = false;
  holdTasksFor = null;
  listeners = {};
  listQueries = [];
  tasksTotal = null;
  (globalThis as Record<string, unknown>).erplora = {
    query: async () => [],
    queryPage: async (name: string, params: Record<string, any> = {}) => {
      listQueries.push({ name, params });
      if (name === 'tasks.projects.list') {
        return { rows: projects.map((p) => ({ ...p })), total: projects.length };
      }
      if (name === 'tasks.tasks.list') {
        const pid = params.filters?.project_id;
        if (holdTasksFor && holdTasksFor.projectId === pid) await holdTasksFor.gate;
        if (failTasksLoad) throw new Error('tasks down');
        const rows = tasks.filter((t) => pid === undefined || t.project_id === pid).map((t) => ({ ...t }));
        return { rows, total: tasksTotal ?? rows.length };
      }
      return { rows: [], total: 0 };
    },
    command: async (name: string, payload: Record<string, unknown>) => {
      commands.push({ name, payload });
      if (refuse) throw new Error(refuse);
      if (name === 'tasks.projects.update') {
        const p = projects.find((x) => x.id === payload.project_id);
        if (p) Object.assign(p, { name: payload.name, color: payload.color, is_active: payload.is_active });
      }
      if (name === 'tasks.tasks.create') {
        tasks.push({ id: `t${tasks.length + 1}`, task_number: `TSK-${tasks.length + 1}`, title: payload.title, status: 'todo', project_id: payload.project_id });
      }
      return {};
    },
    on: (event: string, cb: () => void) => {
      (listeners[event] ??= []).push(cb);
      return () => {};
    },
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

async function mount(): Promise<Wc> {
  await import('./erp-tasks-projects');
  const el = document.createElement('erp-tasks-projects') as Wc;
  document.body.appendChild(el);
  await settle(el);
  return el;
}

const table = (el: Wc) => el.shadowRoot.querySelector('ok-data-table') as HTMLElement & Record<string, any>;
const sheet = (el: Wc) => el.shadowRoot.querySelector('[data-testid="tasks-project-detail"]') as HTMLElement | null;
const text = (n: Element | null) => (n?.textContent ?? '').replace(/\s+/g, ' ').trim();

/** Tap a card: the table hands over a COPY of the row, as the real one does after a re-render. */
async function tap(el: Wc, id: string): Promise<void> {
  const row = { ...(table(el).rows as Row[]).find((r) => r.id === id)! };
  table(el).dispatchEvent(new CustomEvent('rowClick', { detail: { row } }));
  await settle(el);
}

describe('the project card opens the project (tasks#43)', () => {
  it('the card is clickable and carries a visible «Open» action with an icon', async () => {
    const el = await mount();
    expect(table(el).rowClickable, 'a card that is not clickable does nothing when tapped').toBe(true);
    const open = (table(el).actions as { id: string; icon?: string; label: string }[] | undefined)?.find((a) => a.id === 'open');
    expect(open, 'no «Open» action on the card').toBeTruthy();
    expect(open!.icon, 'an action without icon is not painted on the card').toBeTruthy();
    expect(open!.label).toBe('ui.actionOpen');
  });

  it('tapping the card opens the sheet with that project and ONLY its tasks', async () => {
    const el = await mount();
    expect(sheet(el), 'a sheet is open before anything was tapped').toBeNull();
    await tap(el, 'p1');
    const s = sheet(el);
    expect(s, 'tapping the card opened nothing').toBeTruthy();
    expect(text(s)).toContain('Q3 audit');
    expect(text(s)).toContain('q3-audit');
    const q = listQueries.filter((x) => x.name === 'tasks.tasks.list').at(-1);
    expect(q?.params.filters?.project_id, 'the tasks are not filtered by the project').toBe('p1');
    const rows = [...s!.querySelectorAll('[data-testid="tasks-project-task"]')].map(text);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain('TSK-1');
    expect(rows[0]).toContain('Count stock');
  });

  it('the «Open» action does the same as tapping', async () => {
    const el = await mount();
    const row = { ...(table(el).rows as Row[]).find((r) => r.id === 'p2')! };
    table(el).dispatchEvent(new CustomEvent('rowAction', { detail: { actionId: 'open', row } }));
    await settle(el);
    expect(text(sheet(el))).toContain('Salon refit');
    expect(text(sheet(el))).toContain('Paint walls');
  });

  it('a project with no tasks says so', async () => {
    tasks = [];
    const el = await mount();
    await tap(el, 'p1');
    expect(sheet(el)!.querySelector('[data-testid="tasks-project-tasks-empty"]'), 'no empty state').toBeTruthy();
    expect(text(sheet(el))).toContain('ui.emptyProjectTasks');
  });

  it('when its tasks cannot be loaded the sheet says so, not «no tasks»', async () => {
    failTasksLoad = true;
    const el = await mount();
    await tap(el, 'p1');
    expect(sheet(el)!.querySelector('[data-testid="tasks-project-tasks-error"]'), 'load failure is silent').toBeTruthy();
    expect(sheet(el)!.querySelector('[data-testid="tasks-project-tasks-empty"]')).toBeNull();
  });

  it('while its tasks load the sheet says «loading», then the tasks', async () => {
    let release!: () => void;
    holdTasksFor = { projectId: 'p1', gate: new Promise<void>((r) => (release = r)) };
    const el = await mount();
    await tap(el, 'p1');
    expect(sheet(el)!.querySelector('[data-testid="tasks-project-tasks-loading"]'), 'no loading state').toBeTruthy();
    release();
    await settle(el);
    expect(sheet(el)!.querySelector('[data-testid="tasks-project-tasks-loading"]')).toBeNull();
    expect(sheet(el)!.querySelectorAll('[data-testid="tasks-project-task"]')).toHaveLength(1);
  });

  it('opening another project never paints the previous one\'s tasks (late answer)', async () => {
    let release!: () => void;
    holdTasksFor = { projectId: 'p1', gate: new Promise<void>((r) => (release = r)) };
    const el = await mount();
    await tap(el, 'p1');
    await tap(el, 'p2');
    release();
    await settle(el);
    const rows = [...sheet(el)!.querySelectorAll('[data-testid="tasks-project-task"]')].map(text);
    expect(text(sheet(el))).toContain('Salon refit');
    expect(rows.join(' | ')).not.toContain('Count stock');
    expect(rows.join(' | ')).toContain('Paint walls');
  });

  it('while the next project loads, the previous project\'s tasks are already gone', async () => {
    const el = await mount();
    await tap(el, 'p1');
    expect(text(sheet(el))).toContain('Count stock');
    holdTasksFor = { projectId: 'p2', gate: new Promise<void>(() => {}) };
    await tap(el, 'p2');
    expect(text(sheet(el))).toContain('Salon refit');
    expect(text(sheet(el)), 'p1\'s tasks are shown under p2').not.toContain('Count stock');
    expect(sheet(el)!.querySelector('[data-testid="tasks-project-tasks-loading"]')).toBeTruthy();
  });

  it('a project with more tasks than the sheet lists says how many there are', async () => {
    tasksTotal = 120;
    const el = await mount();
    await tap(el, 'p1');
    const q = listQueries.filter((x) => x.name === 'tasks.tasks.list').at(-1);
    expect(q?.params.limit).toBe(50);
    expect(text(sheet(el))).toContain('ui.projectTasksMore');
    tasksTotal = null;
    await tap(el, 'p2');
    expect(text(sheet(el))).not.toContain('ui.projectTasksMore');
  });

  it('«Close» closes the sheet', async () => {
    const el = await mount();
    await tap(el, 'p1');
    (sheet(el)!.querySelector('[data-testid="tasks-project-close"]') as HTMLElement).click();
    await settle(el);
    expect(sheet(el)).toBeNull();
  });
});

describe('the sheet manages the project', () => {
  it('Save sends tasks.projects.update with the edited fields and shows what the SERVER now has', async () => {
    const el = await mount();
    await tap(el, 'p1');
    el.editName = 'Q3 audit (stores)';
    el.editColor = '#00aa00';
    await el.saveProject(new Event('submit'));
    await settle(el);
    const cmd = commands.find((c) => c.name === 'tasks.projects.update');
    expect(cmd?.payload).toEqual({ project_id: 'p1', name: 'Q3 audit (stores)', color: '#00aa00', is_active: 1 });
    expect(text(sheet(el).querySelector('h3'))).toBe('Q3 audit (stores)');
    const listed = (table(el).rows as Row[]).find((r) => r.id === 'p1');
    expect(listed?.name, 'the list was not re-read after saving').toBe('Q3 audit (stores)');
  });

  it('saving an INACTIVE project keeps it inactive', async () => {
    projects[1].is_active = 0;
    const el = await mount();
    await tap(el, 'p2');
    el.editName = 'Salon refit 2';
    await el.saveProject(new Event('submit'));
    await settle(el);
    expect(commands.find((c) => c.name === 'tasks.projects.update')?.payload.is_active).toBe(0);
  });

  it('a blank name is not sent', async () => {
    const el = await mount();
    await tap(el, 'p1');
    el.editName = '   ';
    await el.saveProject(new Event('submit'));
    expect(commands.filter((c) => c.name === 'tasks.projects.update')).toHaveLength(0);
  });

  it('«Deactivate» keeps name and colour and sends is_active 0; then it offers «Activate»', async () => {
    const el = await mount();
    await tap(el, 'p1');
    el.editName = 'unsaved typing';
    const btn = sheet(el)!.querySelector('[data-testid="tasks-project-toggle-active"]') as HTMLElement;
    expect(text(btn)).toBe('ui.actionDeactivate');
    btn.click();
    await settle(el);
    const cmd = commands.find((c) => c.name === 'tasks.projects.update');
    expect(cmd?.payload).toEqual({ project_id: 'p1', name: 'Q3 audit', color: '#ff0000', is_active: 0 });
    expect(text(sheet(el)!.querySelector('[data-testid="tasks-project-toggle-active"]'))).toBe('ui.actionActivate');
    expect(text(sheet(el)!.querySelector('[data-testid="tasks-project-state"]'))).toBe('ui.projectInactive');
    (sheet(el)!.querySelector('[data-testid="tasks-project-toggle-active"]') as HTMLElement).click();
    await settle(el);
    expect(commands.filter((c) => c.name === 'tasks.projects.update').at(-1)?.payload.is_active).toBe(1);
    expect(text(sheet(el)!.querySelector('[data-testid="tasks-project-state"]'))).toBe('ui.projectActive');
  });

  it('a refusal is painted INSIDE the sheet, which stays open', async () => {
    const el = await mount();
    await tap(el, 'p1');
    refuse = 'That project does not exist in this business.';
    el.editName = 'Renamed';
    await el.saveProject(new Event('submit'));
    await settle(el);
    expect(sheet(el), 'the refusal closed the sheet').toBeTruthy();
    expect(text(sheet(el)!.querySelector('[data-testid="tasks-project-detail-error"]'))).toBe(refuse);
  });

  it('«Add task» creates the task IN this project and lists it', async () => {
    const el = await mount();
    await tap(el, 'p1');
    el.newTaskTitle = 'Call the landlord';
    await el.addTask(new Event('submit'));
    await settle(el);
    const cmd = commands.find((c) => c.name === 'tasks.tasks.create');
    expect(cmd?.payload.project_id).toBe('p1');
    expect(cmd?.payload.title).toBe('Call the landlord');
    const rows = [...sheet(el)!.querySelectorAll('[data-testid="tasks-project-task"]')].map(text);
    expect(rows.join(' | ')).toContain('Call the landlord');
    expect(el.newTaskTitle, 'the box keeps what was just added').toBe('');
  });

  it('a refused «Add task» keeps the text and says why inside the sheet', async () => {
    const el = await mount();
    await tap(el, 'p1');
    refuse = 'nope';
    el.newTaskTitle = 'Call the landlord';
    await el.addTask(new Event('submit'));
    await settle(el);
    expect(el.newTaskTitle).toBe('Call the landlord');
    expect(text(sheet(el)!.querySelector('[data-testid="tasks-project-detail-error"]'))).toBe('nope');
  });

  it('an edit made elsewhere (tasks.project.updated) re-reads the list', async () => {
    const el = await mount();
    const before = listQueries.filter((q) => q.name === 'tasks.projects.list').length;
    expect(listeners['tasks.project.updated']?.length, 'nobody listens to tasks.project.updated').toBeTruthy();
    listeners['tasks.project.updated'].forEach((cb) => cb());
    await settle(el);
    expect(listQueries.filter((q) => q.name === 'tasks.projects.list').length).toBeGreaterThan(before);
  });
});

describe('every string the Projects page paints exists in en AND es', () => {
  it('no ui.* key used by the component is missing from a catalogue', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, 'erp-tasks-projects.ts'), 'utf8');
    const keys = [...new Set([...src.matchAll(/\bt\('ui\.([A-Za-z_.]+)'/g)].map((m) => m[1]))];
    expect(keys.length).toBeGreaterThan(10);
    const lookup = (cat: any, k: string) => k.split('.').reduce((o, p) => (o == null ? o : o[p]), cat.ui);
    for (const [lang, cat] of [['en', enLocale], ['es', esLocale]] as const) {
      const missing = keys.filter((k) => typeof lookup(cat, k) !== 'string' || !lookup(cat, k).trim());
      expect(missing, `locales/${lang}.json lacks`).toEqual([]);
    }
  });
});
