// A list that could not load must not read «No tasks» / «No projects» + «0 records» (pm#533, hub#2328).
//
// The shell's `<ok-data-table>` (OutfitKit ≥ 0.1.113) paints a failed load itself: «could not
// load», the reason and a Retry button. Every list screen hands it its controller's `error` and
// reloads on its `retry` event — and drops its own red banner, which would say the same thing
// twice. But a module paints with the SHELL's OutfitKit (ADR-0451): on a hub whose table has no
// `error` property the banner is the only place the reason is shown, so it stays.
//
// The shell's table is stood in for by a bare element registered BEFORE the screens load (as the
// shell does at boot; the screen's own `define()` then loses, like in the hub). Its `error`
// property is added or removed per test, which is exactly what `dataTableShowsLoadError()` reads.
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

class ShellTable extends HTMLElement {}
const errors = new WeakMap<HTMLElement, unknown>();

function shellTableKnowsErrors(yes: boolean) {
  if (yes) {
    Object.defineProperty(ShellTable.prototype, 'error', {
      configurable: true,
      get(this: HTMLElement) { return errors.get(this) ?? ''; },
      set(this: HTMLElement, v: unknown) { errors.set(this, v); },
    });
  } else {
    delete (ShellTable.prototype as { error?: unknown }).error;
  }
}

const SCREENS = [
  { tag: 'erp-tasks-list', banner: 'tasks-list-load-error', list: 'tasks.tasks.list' },
  { tag: 'erp-tasks-projects', banner: 'tasks-projects-load-error', list: 'tasks.projects.list' },
] as const;

const ROW = { id: 'r1', task_number: 'T-1', title: 'Call the supplier', name: 'Launch', code: 'LCH', status: 'todo', priority: 'medium' };
const ME = 'user-me';

let hubAnswers = false;
let pageCalls = 0;
let pageNames: string[] = [];
let queryCalls: string[] = [];

beforeAll(async () => {
  customElements.define('ok-data-table', ShellTable);
  await import('../components/erp-tasks-list/erp-tasks-list');
  await import('../components/erp-tasks-projects/erp-tasks-projects');
});

beforeEach(() => {
  document.body.innerHTML = '';
  hubAnswers = false;
  pageCalls = 0;
  pageNames = [];
  queryCalls = [];
  localStorage.clear();
  localStorage.setItem('erplora.session', JSON.stringify({ id: ME, name: 'Me' }));
  const answer = async (name: string) => {
    queryCalls.push(name);
    if (!hubAnswers) throw new Error('The hub is not responding.');
    return name === 'tasks.tasks.my' ? [ROW] : [];
  };
  (globalThis as Record<string, unknown>).erplora = {
    query: answer,
    queryOptional: answer,
    queryPage: async (name: string) => {
      pageCalls++;
      pageNames.push(name);
      if (!hubAnswers) throw new Error('The hub is not responding.');
      return { rows: [ROW], total: 1 };
    },
    queryAll: async () => [],
    command: async () => ({}),
    hasPermission: () => true,
    on: () => () => {},
    locale: 'es',
    t: (_catalog: unknown, key: string) => key,
    currency: 'EUR',
    currencyDecimals: 2,
    formatMoney: (cents: number) => `${(cents / 100).toFixed(2)} €`,
  };
});

type Screen = HTMLElement & { shadowRoot: ShadowRoot; updateComplete: Promise<unknown> };

async function mountFailed(tag: string): Promise<{ el: Screen; table: HTMLElement }> {
  const el = document.createElement(tag) as Screen;
  document.body.appendChild(el);
  await vi.waitFor(() => {
    if (pageCalls === 0) throw new Error('the list has not asked for its page yet');
  });
  await el.updateComplete;
  await new Promise((r) => setTimeout(r, 0));
  await el.updateComplete;
  const table = el.shadowRoot.querySelector<HTMLElement>('ok-data-table');
  expect(table, `${tag} paints its table`).toBeTruthy();
  return { el, table: table! };
}

describe.each(SCREENS)('$tag — a list that could not load (pm#533)', ({ tag, banner, list }) => {
  it('hands the reason to the shell table and paints no second banner', async () => {
    shellTableKnowsErrors(true);
    const { el, table } = await mountFailed(tag);
    expect((table as unknown as { error: string }).error).toBe('The hub is not responding.');
    expect(el.shadowRoot.querySelector(`[data-testid="${banner}"]`), 'the reason would be said twice').toBeNull();
  });

  it('Retry on the table asks the hub again and paints the rows that now arrive', async () => {
    shellTableKnowsErrors(true);
    const { el, table } = await mountFailed(tag);
    const before = pageNames.filter((n) => n === list).length;
    hubAnswers = true;
    table.dispatchEvent(new CustomEvent('retry', { detail: {} }));
    await vi.waitFor(() => {
      if (pageNames.filter((n) => n === list).length === before) throw new Error('Retry did not ask the hub again');
    });
    await vi.waitFor(async () => {
      await el.updateComplete;
      if ((table as unknown as { error: string }).error !== '') throw new Error('the error is still on the table');
    });
    expect((table as unknown as { rows: unknown[] }).rows).toEqual([ROW]);
  });

  it('on a shell whose table cannot paint the error, keeps its own banner with the reason', async () => {
    shellTableKnowsErrors(false);
    const { el } = await mountFailed(tag);
    const shown = el.shadowRoot.querySelector(`[data-testid="${banner}"]`);
    expect(shown, 'an older hub would show the failure nowhere').toBeTruthy();
    expect(shown!.textContent).toContain('The hub is not responding.');
  });
});

describe('erp-tasks-list «Mine» tab — the list could not load (pm#533)', () => {
  const BANNER = 'tasks-mine-load-error';

  async function mountMineFailed(): Promise<{ el: Screen; table: HTMLElement }> {
    hubAnswers = true;
    const { el } = await mountFailed('erp-tasks-list');
    hubAnswers = false;
    (el as unknown as { setView(v: string): void }).setView('mine');
    await vi.waitFor(() => {
      if (!queryCalls.includes('tasks.tasks.my')) throw new Error('the «Mine» tab has not asked yet');
    });
    await vi.waitFor(async () => {
      await el.updateComplete;
      if ((el as unknown as { myLoading: boolean }).myLoading) throw new Error('still loading');
    });
    await el.updateComplete;
    const table = el.shadowRoot.querySelector<HTMLElement>('ok-data-table');
    expect(table, 'the «Mine» tab paints its table').toBeTruthy();
    return { el, table: table! };
  }

  it('hands the reason to the shell table and paints no second banner', async () => {
    shellTableKnowsErrors(true);
    const { el, table } = await mountMineFailed();
    expect((table as unknown as { error: string }).error).toBe('The hub is not responding.');
    expect(el.shadowRoot.querySelector(`[data-testid="${BANNER}"]`), 'the reason would be said twice').toBeNull();
  });

  it('Retry on the table asks the hub again and paints the tasks that now arrive', async () => {
    shellTableKnowsErrors(true);
    const { el, table } = await mountMineFailed();
    const before = queryCalls.filter((n) => n === 'tasks.tasks.my').length;
    hubAnswers = true;
    table.dispatchEvent(new CustomEvent('retry', { detail: {} }));
    await vi.waitFor(() => {
      if (queryCalls.filter((n) => n === 'tasks.tasks.my').length === before) throw new Error('Retry did not ask the hub again');
    });
    await vi.waitFor(async () => {
      await el.updateComplete;
      if ((table as unknown as { error: string }).error !== '') throw new Error('the error is still on the table');
    });
    expect((table as unknown as { rows: unknown[] }).rows).toEqual([ROW]);
  });

  it('on a shell whose table cannot paint the error, keeps its own banner with the reason', async () => {
    shellTableKnowsErrors(false);
    const { el } = await mountMineFailed();
    const shown = el.shadowRoot.querySelector(`[data-testid="${BANNER}"]`);
    expect(shown, 'an older hub would show the failure nowhere').toBeTruthy();
    expect(shown!.textContent).toContain('The hub is not responding.');
  });
});
