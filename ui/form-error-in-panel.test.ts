// pm#513 (out of pm#478) — on a phone or a tablet, a refused «Add» in Tasks or Projects showed
// NOTHING: the person pressed «Add» and the sheet stayed as it was.
//
// The refusal did arrive; it was painted in the wrong place. Both forms live in the `create` panel
// of their `ok-data-table`, and under 834 px that panel is a FULL-SCREEN sheet (outfitkit#75). The
// error line was a child of the PAGE, so on a phone it sat under the sheet, out of sight (bench:
// hub:stable 1.1.30, 390 and 820 px, ios and md). On a desktop the panel sits beside the table and
// the line happened to be visible.
//
// And a refused «Start» / «Complete» from a row of the table showed nothing at ANY width: the row
// action wrote to the error of the task DETAIL, which is only painted while a detail is open.
//
// The rule, the same one customers#97 / tables#93 / reservations#73 / appointments#227 follow:
//
//   · what goes wrong while SAVING the panel's form is painted INSIDE that form, next to the button
//     that was pressed, and scrolled into view once — not again on every keystroke (rv-reservations-73);
//   · what goes wrong OUTSIDE the save (a row action, a list that does not load) stays on the PAGE:
//     no panel is open then, and a message inside a closed panel is just as invisible
//     (rv-appointments-227). What goes wrong inside an open detail stays in that detail.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const TASK = {
  id: 't1',
  task_number: 'TSK-1',
  title: 'Check the till',
  description: '',
  project_id: null,
  status: 'todo',
  priority: 'medium',
  assigned_to_ref: null,
  created_by_ref: null,
  due_date: null,
  completed_at: null,
  parent_task_id: null,
  tags: '',
  created_at: '2026-07-13T09:00:00',
};
const PROJECT = { id: 'p1', code: 'q3-audit', name: 'Q3 audit', color: '', is_active: 1 };

const REFUSAL = 'A manager has to approve this.';

let refuse: string | null = null;
/** When set, the next command waits on it: lets a test look at the screen while a save is in flight. */
let hold: Promise<void> | null = null;
let loadFails = false;
/** Every element the component scrolled into view. */
let revealed: Element[] = [];

beforeEach(() => {
  refuse = null;
  hold = null;
  loadFails = false;
  revealed = [];
  localStorage.clear();
  vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(function (this: HTMLElement) {
    revealed.push(this);
  });
  (globalThis as Record<string, unknown>).erplora = {
    query: async (name: string) => (name === 'tasks.tasks.get' ? [TASK] : []),
    queryPage: async (name: string) => {
      if (loadFails) throw new Error('list down');
      return name === 'tasks.projects.list' ? { rows: [PROJECT], total: 1 } : { rows: [TASK], total: 1 };
    },
    command: async () => {
      const wait = hold;
      if (wait) await wait;
      if (refuse) throw new Error(refuse);
      return {};
    },
    on: () => () => {},
    locale: 'es',
    t: (_c: unknown, key: string) => key,
  };
});

type Wc = HTMLElement & { shadowRoot: ShadowRoot; updateComplete: Promise<unknown> } & Record<string, any>;

async function mount(tag: 'erp-tasks-list' | 'erp-tasks-projects'): Promise<Wc> {
  if (tag === 'erp-tasks-list') await import('./components/erp-tasks-list/erp-tasks-list');
  else await import('./components/erp-tasks-projects/erp-tasks-projects');
  const el = document.createElement(tag) as Wc;
  document.body.appendChild(el);
  await settle(el);
  return el;
}

async function settle(el: Wc): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await el.updateComplete;
    await new Promise((r) => setTimeout(r, 0));
  }
}

const submitEvent = (): Event => new Event('submit', { cancelable: true });

/** The notice INSIDE the panel's form, or null. */
const inForm = (el: Wc, testid: string): Element | null =>
  el.shadowRoot.querySelector(`form[slot="create"] [data-testid="${testid}"]`);

/** The notice on the PAGE (outside the panel and outside the detail), or null. */
const onPage = (el: Wc, testid: string): Element | null => {
  const notice = el.shadowRoot.querySelector(`[data-testid="${testid}"]`);
  return notice && !notice.closest('form[slot="create"]') && !notice.closest('section.detail') ? notice : null;
};

/**
 * Every load failure painted outside the panel's form: the module's own notice or, when the
 * loaded outfitkit gives `ok-data-table` an `error` state (pm#533), the table itself. An older
 * table ignores the property and paints nothing, so there it does not count.
 */
function failuresOutsideTheForm(el: Wc): string[] {
  const outside = (n: Element): boolean => !n.closest('form[slot="create"]');
  const notices = [...el.shadowRoot.querySelectorAll('.err')].filter(outside).map((n) => n.textContent?.trim() ?? '');
  const table = customElements.get('ok-data-table');
  const tables =
    table && 'error' in table.prototype
      ? [...el.shadowRoot.querySelectorAll('ok-data-table')]
          .filter(outside)
          .map((n) => (n as HTMLElement & { error?: string }).error ?? '')
      : [];
  return [...notices, ...tables];
}

/** Every place the refusal text is painted in, by where it sits. */
function whereIsTheRefusal(el: Wc): string[] {
  return [...el.shadowRoot.querySelectorAll('*')]
    .filter((n) => n.children.length === 0 && n.textContent?.trim() === REFUSAL)
    .map((n) => (n.closest('form[slot="create"]') ? 'form' : n.closest('section.detail') ? 'detail' : 'page'));
}

async function refusedCreateTask(el: Wc): Promise<void> {
  el.newTitle = 'Call the supplier';
  refuse = REFUSAL;
  await el.createTask(submitEvent());
  await settle(el);
}

async function refusedCreateProject(el: Wc): Promise<void> {
  el.newCode = 'x1';
  el.newName = 'Refit';
  refuse = REFUSAL;
  await el.createProject(submitEvent());
  await settle(el);
}

const rowAction = (el: Wc, actionId: string): Promise<void> => el.onRowAction({ detail: { actionId, row: TASK } });

describe('pm#513 · tasks: a refused «Add» is shown INSIDE the panel form', () => {
  it('lands in the form, with its text, scrolled into view — nothing on the page under the sheet', async () => {
    const el = await mount('erp-tasks-list');
    await refusedCreateTask(el);
    const notice = inForm(el, 'tasks-list-form-error');
    expect(notice, 'on a phone the panel covers the page: the refusal has to travel with the form').not.toBeNull();
    expect(notice?.textContent?.trim()).toBe(REFUSAL);
    expect(revealed, 'and it is scrolled into view').toContain(notice);
    expect(whereIsTheRefusal(el)).toEqual(['form']);
  });

  it('sits above the «Add» button that was pressed', async () => {
    const el = await mount('erp-tasks-list');
    await refusedCreateTask(el);
    const form = el.shadowRoot.querySelector('form[slot="create"]') as HTMLFormElement;
    const kids = [...form.children];
    const notice = kids.findIndex((k) => k.getAttribute('data-testid') === 'tasks-list-form-error');
    const button = kids.findIndex((k) => k.tagName === 'ION-BUTTON');
    expect(notice).toBeGreaterThanOrEqual(0);
    expect(notice).toBeLessThan(button);
  });

  it('is revealed once, not again on every keystroke while the person corrects the title', async () => {
    const el = await mount('erp-tasks-list');
    await refusedCreateTask(el);
    revealed = [];
    el.newTitle = 'Call the supplier today';
    await settle(el);
    expect(inForm(el, 'tasks-list-form-error'), 'the refusal is still there').not.toBeNull();
    expect(revealed, 'but the sheet stays where the person is typing').toEqual([]);
  });

  it('while the new attempt is being saved, the previous refusal is already gone', async () => {
    const el = await mount('erp-tasks-list');
    await refusedCreateTask(el);
    refuse = null;
    let release!: () => void;
    hold = new Promise((r) => (release = r));
    el.newTitle = 'Call the supplier';
    const attempt = el.createTask(submitEvent());
    await settle(el);
    expect(inForm(el, 'tasks-list-form-error')).toBeNull();
    release();
    await attempt;
  });

  it('a save that goes through also clears the page refusal of an earlier row action', async () => {
    const el = await mount('erp-tasks-list');
    refuse = REFUSAL;
    await rowAction(el, 'complete');
    await settle(el);
    refuse = null;
    el.newTitle = 'Call the supplier';
    await el.createTask(submitEvent());
    await settle(el);
    expect(whereIsTheRefusal(el)).toEqual([]);
  });
});

describe('pm#513 · tasks: what goes wrong OUTSIDE the save stays on the page', () => {
  it.each(['complete', 'start'])('a refused «%s» from a row is shown on the page, with no detail open', async (actionId) => {
    const el = await mount('erp-tasks-list');
    refuse = REFUSAL;
    await rowAction(el, actionId);
    await settle(el);
    const notice = onPage(el, 'tasks-list-error');
    expect(notice, 'before, it went to the detail error, which is not painted without a detail').not.toBeNull();
    expect(notice?.textContent?.trim()).toBe(REFUSAL);
    expect(whereIsTheRefusal(el)).toEqual(['page']);
  });

  it('a refused row action stays on the page even with a detail open', async () => {
    const el = await mount('erp-tasks-list');
    el.openDetail(TASK);
    await settle(el);
    refuse = REFUSAL;
    await rowAction(el, 'complete');
    await settle(el);
    expect(whereIsTheRefusal(el)).toEqual(['page']);
  });

  it('a refused row action is shown on the page of «My tasks» too', async () => {
    localStorage.setItem('erplora.session', JSON.stringify({ id: 'u1' }));
    const el = await mount('erp-tasks-list');
    el.setView('mine');
    await settle(el);
    refuse = REFUSAL;
    await rowAction(el, 'complete');
    await settle(el);
    expect(onPage(el, 'tasks-list-error')?.textContent?.trim()).toBe(REFUSAL);
  });

  it('a row action that goes through refreshes the list, and «My tasks» when that is the view', async () => {
    localStorage.setItem('erplora.session', JSON.stringify({ id: 'u1' }));
    const el = await mount('erp-tasks-list');
    el.setView('mine');
    await settle(el);
    const api = (globalThis as Record<string, any>).erplora;
    const reads: string[] = [];
    const { query, queryPage } = api;
    api.query = (name: string, ...rest: unknown[]) => (reads.push(name), query(name, ...rest));
    api.queryPage = (name: string, ...rest: unknown[]) => (reads.push(`page:${name}`), queryPage(name, ...rest));
    await rowAction(el, 'complete');
    await settle(el);
    expect(reads.some((r) => r.startsWith('page:')), 'the completed row has to leave «to do» in the table').toBe(true);
    expect(reads, 'and in «My tasks» too').toContain('tasks.tasks.my');
  });

  it('a new row action clears the previous refusal while it runs', async () => {
    const el = await mount('erp-tasks-list');
    refuse = REFUSAL;
    await rowAction(el, 'complete');
    await settle(el);
    refuse = null;
    let release!: () => void;
    hold = new Promise((r) => (release = r));
    const attempt = rowAction(el, 'start');
    await settle(el);
    expect(onPage(el, 'tasks-list-error')).toBeNull();
    release();
    await attempt;
  });

  it('a refused action inside an open detail stays in that detail', async () => {
    const el = await mount('erp-tasks-list');
    el.openDetail(TASK);
    await settle(el);
    refuse = REFUSAL;
    await el.completeTask();
    await settle(el);
    expect(whereIsTheRefusal(el)).toEqual(['detail']);
  });

  it('a list that does not load is shown on the page, not in the form', async () => {
    loadFails = true;
    const el = await mount('erp-tasks-list');
    const inside = el.shadowRoot.querySelector('form[slot="create"] .err');
    expect(inside).toBeNull();
    expect(failuresOutsideTheForm(el)).toContain('list down');
  });
});

describe('pm#513 · projects: a refused «Add» is shown INSIDE the panel form', () => {
  it('lands in the form, with its text, scrolled into view — nothing on the page under the sheet', async () => {
    const el = await mount('erp-tasks-projects');
    await refusedCreateProject(el);
    const notice = inForm(el, 'tasks-projects-form-error');
    expect(notice, 'on a phone the panel covers the page: the refusal has to travel with the form').not.toBeNull();
    expect(notice?.textContent?.trim()).toBe(REFUSAL);
    expect(revealed, 'and it is scrolled into view').toContain(notice);
    expect(whereIsTheRefusal(el)).toEqual(['form']);
  });

  it('sits above the «Add» button that was pressed', async () => {
    const el = await mount('erp-tasks-projects');
    await refusedCreateProject(el);
    const kids = [...(el.shadowRoot.querySelector('form[slot="create"]') as HTMLFormElement).children];
    const notice = kids.findIndex((k) => k.getAttribute('data-testid') === 'tasks-projects-form-error');
    expect(notice).toBeGreaterThanOrEqual(0);
    expect(notice).toBeLessThan(kids.findIndex((k) => k.tagName === 'ION-BUTTON'));
  });

  it('is revealed once, not again on every keystroke while the person corrects a field', async () => {
    const el = await mount('erp-tasks-projects');
    await refusedCreateProject(el);
    revealed = [];
    el.newName = 'Refit 2';
    await settle(el);
    expect(inForm(el, 'tasks-projects-form-error'), 'the refusal is still there').not.toBeNull();
    expect(revealed, 'but the sheet stays where the person is typing').toEqual([]);
  });

  it('while the new attempt is being saved, the previous refusal is already gone', async () => {
    const el = await mount('erp-tasks-projects');
    await refusedCreateProject(el);
    refuse = null;
    let release!: () => void;
    hold = new Promise((r) => (release = r));
    el.newCode = 'x1';
    el.newName = 'Refit';
    const attempt = el.createProject(submitEvent());
    await settle(el);
    expect(inForm(el, 'tasks-projects-form-error')).toBeNull();
    release();
    await attempt;
  });

  it('a list that does not load is shown on the page, not in the form', async () => {
    loadFails = true;
    const el = await mount('erp-tasks-projects');
    const inside = el.shadowRoot.querySelector('form[slot="create"] .err');
    expect(inside).toBeNull();
    expect(failuresOutsideTheForm(el)).toContain('list down');
  });
});
