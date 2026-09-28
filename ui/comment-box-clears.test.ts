// tasks#44 — on a phone, right after «Comment» the new comment was already in the thread and the
// box still held the sentence that had just been sent.
//
// The box was only emptied at the very END of the command: after the hub accepted the comment AND
// the table, «My tasks» and the whole detail had been reloaded one after the other. Meanwhile the
// `tasks.comment.added` event had already repainted the thread. On a hub reached over a mobile
// network that gap lasts seconds (bench: hub:stable 1.1.30, 390 px, 1.2 s per query → comment in
// the thread at 2.5 s, box emptied at 3.7 s), and it reads as «it did not go through, press again».
//
// The rule, the one every chat and comment box follows (Slack, GitHub, Odoo's chatter): the box is
// emptied the moment the hub ACCEPTS what was sent — not when the screen has finished refreshing.
// A refusal keeps the text so it can be sent again, and whatever the person started typing while
// it was on its way is theirs: it is not wiped. The subtask box, same form pattern, same rule.
import { beforeEach, describe, expect, it } from 'vitest';

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

const REFUSAL = 'The task is closed.';

const commands: { name: string; payload: Record<string, unknown> }[] = [];
let refuse: string | null = null;
/** When set, every query after the command waits on it: the screen is still refreshing. */
let refreshing: Promise<void> | null = null;
let endRefresh: () => void = () => {};
/** When set, the command itself waits on it: the comment is still on its way to the hub. */
let sending: Promise<void> | null = null;
let accept: () => void = () => {};
let refreshQueries = 0;

function holdRefresh() {
  refreshing = new Promise<void>((r) => (endRefresh = r));
}
function holdSend() {
  sending = new Promise<void>((r) => (accept = r));
}

beforeEach(() => {
  commands.length = 0;
  refuse = null;
  refreshing = null;
  sending = null;
  refreshQueries = 0;
  localStorage.clear();
  const wait = async () => {
    if (refreshing) {
      refreshQueries++;
      await refreshing;
    }
  };
  (globalThis as Record<string, unknown>).erplora = {
    query: async (name: string) => {
      await wait();
      return name === 'tasks.tasks.get' ? [TASK] : [];
    },
    queryPage: async () => {
      await wait();
      return { rows: [TASK], total: 1 };
    },
    command: async (name: string, payload: Record<string, unknown>) => {
      commands.push({ name, payload });
      if (sending) await sending;
      if (refuse) throw new Error(refuse);
      return {};
    },
    on: () => () => {},
    notify: () => {},
    locale: 'en',
    t: (_catalog: unknown, key: string) => key,
  };
});

type Host = HTMLElement & {
  shadowRoot: ShadowRoot;
  updateComplete: Promise<unknown>;
  openDetail: (t: unknown) => void;
};

const tick = () => new Promise((r) => setTimeout(r, 0));
async function settle(el: Host) {
  for (let i = 0; i < 4; i++) {
    await tick();
    await el.updateComplete;
  }
}

async function openTask(): Promise<Host> {
  await import('./components/erp-tasks-list/erp-tasks-list');
  const el = document.createElement('erp-tasks-list') as Host;
  document.body.appendChild(el);
  await settle(el);
  el.openDetail(TASK);
  await settle(el);
  commands.length = 0;
  return el;
}

const commentForm = (el: Host) => el.shadowRoot.querySelector('form.comment-form:has(ion-textarea)') as HTMLFormElement;
const commentBox = (el: Host) => commentForm(el).querySelector('ion-textarea') as HTMLElement & { value: string };
const subtaskForm = (el: Host) => el.shadowRoot.querySelector('form.comment-form:has(ion-input)') as HTMLFormElement;
const subtaskBox = (el: Host) => subtaskForm(el).querySelector('ion-input') as HTMLElement & { value: string };

async function type(el: Host, box: HTMLElement & { value: string }, text: string) {
  box.value = text;
  box.dispatchEvent(new CustomEvent('ionInput', { bubbles: true }));
  await el.updateComplete;
}
async function submit(el: Host, form: HTMLFormElement) {
  form.dispatchEvent(new Event('submit', { cancelable: true }));
  await settle(el);
}
const sent = (name: string) => commands.filter((c) => c.name === name);

describe('the comment box empties as soon as the hub accepts the comment (tasks#44)', () => {
  it('is empty while the screen is still refreshing after the comment was accepted', async () => {
    const el = await openTask();
    await type(el, commentBox(el), 'Customer wants another colour');
    holdRefresh();
    await submit(el, commentForm(el));

    expect(sent('tasks.tasks.add_comment').map((c) => c.payload.comment)).toEqual(['Customer wants another colour']);
    expect(refreshQueries, 'the test must look at the box DURING the refresh').toBeGreaterThan(0);
    expect(commentBox(el).value, 'the sentence just sent is still in the box').toBe('');

    endRefresh();
    await settle(el);
    expect(commentBox(el).value).toBe('');
  });

  it('a second press during the refresh does not post the same comment again', async () => {
    const el = await openTask();
    await type(el, commentBox(el), 'Customer wants another colour');
    holdRefresh();
    await submit(el, commentForm(el));
    await submit(el, commentForm(el));
    endRefresh();
    await settle(el);

    expect(sent('tasks.tasks.add_comment')).toHaveLength(1);
  });

  it('keeps the text while the comment is still on its way to the hub', async () => {
    const el = await openTask();
    await type(el, commentBox(el), 'Customer wants another colour');
    holdSend();
    await submit(el, commentForm(el));

    expect(commentBox(el).value, 'emptied before the hub said yes: a refusal would lose it').toBe(
      'Customer wants another colour',
    );
    accept();
    await settle(el);
    expect(commentBox(el).value).toBe('');
  });

  it('a refused comment stays in the box, next to the refusal, ready to send again', async () => {
    const el = await openTask();
    await type(el, commentBox(el), 'Customer wants another colour');
    refuse = REFUSAL;
    await submit(el, commentForm(el));

    expect(commentBox(el).value).toBe('Customer wants another colour');
    expect(el.shadowRoot.querySelector('section.detail')?.textContent).toContain(REFUSAL);
  });

  it('what the person types while the comment is on its way is not wiped when it is accepted', async () => {
    const el = await openTask();
    await type(el, commentBox(el), 'Customer wants another colour');
    holdSend();
    await submit(el, commentForm(el));
    await type(el, commentBox(el), 'And a shorter cut');
    accept();
    await settle(el);

    expect(commentBox(el).value).toBe('And a shorter cut');
  });
});

describe('the subtask box follows the same rule', () => {
  it('is empty while the screen is still refreshing after the subtask was accepted', async () => {
    const el = await openTask();
    await type(el, subtaskBox(el), 'Buy dye');
    holdRefresh();
    await submit(el, subtaskForm(el));

    expect(sent('tasks.tasks.create').map((c) => c.payload.title)).toEqual(['Buy dye']);
    expect(refreshQueries).toBeGreaterThan(0);
    expect(subtaskBox(el).value, 'the title just added is still in the box').toBe('');
    endRefresh();
    await settle(el);
  });

  it('a refused subtask keeps its title', async () => {
    const el = await openTask();
    await type(el, subtaskBox(el), 'Buy dye');
    refuse = REFUSAL;
    await submit(el, subtaskForm(el));

    expect(subtaskBox(el).value).toBe('Buy dye');
  });

  it('what the person types while the subtask is on its way is not wiped when it is accepted', async () => {
    const el = await openTask();
    await type(el, subtaskBox(el), 'Buy dye');
    holdSend();
    await submit(el, subtaskForm(el));
    await type(el, subtaskBox(el), 'Book the supplier');
    accept();
    await settle(el);

    expect(subtaskBox(el).value).toBe('Book the supplier');
  });
});
