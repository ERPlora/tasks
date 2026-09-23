// No `ion-*` of this module takes its colour from `color=` (ERPlora/pm#392, module-toolkit#273).
//
// Ionic implements `color="success"` with a GLOBAL rule of the document stylesheet
// (`.ion-color-success { --ion-color-base: … }`), which does not reach inside a shadow root. In the
// task list that meant: the priority chip of every row and of the detail header came out with no
// background (white text on white — the «Urgent» chip unreadable), the solid «Complete» button of
// the detail had an invisible fill, and the outline «Unassign» button fell back to primary blue.
//
// Two recipes, by where the element lives:
//   · the priority chip is rendered by a column `render` that `ok-data-table` evaluates inside ITS
//     OWN shadow root, where this component's `static styles` never arrive → the tone goes INLINE,
//     as custom properties read from the theme token (`ionTone`);
//   · the detail buttons live in this component's shadow root → a `tone-*` class painted from
//     `static styles`.
//
// happy-dom neither lays out nor loads Ionic's CSS, so what is pinned here is the CONTRACT; the
// computed colours were measured in a real browser.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { ionTone } from './lib/ion-tone';

// The `ui/` of THIS checkout, from the test's own URL: a fixed folder name (`modules/tasks`, a
// worktree) would scan a sibling checkout and let a `color=` added HERE through.
const UI = path.dirname(fileURLToPath(import.meta.url));

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sources(full));
    else if (/\.ts$/.test(entry.name) && !/\.(test|spec)\.ts$/.test(entry.name)) out.push(full);
  }
  return out;
}

/**
 * The attribute names of every `<ion-*>` opening tag. A Lit tag does not end at the first `>`
 * (`@click=${() => …}`), so `${…}` expressions and quoted values are skipped, not read.
 */
function ionTags(source: string): { line: number; attrs: string }[] {
  const found: { line: number; attrs: string }[] = [];
  const start = /<ion-[a-z-]+(?=[\s/>])/g;
  let m: RegExpExecArray | null;
  while ((m = start.exec(source))) {
    let attrs = '';
    let depth = 0;
    let quote: string | null = null;
    for (let i = m.index + m[0].length; i < source.length; i += 1) {
      const ch = source[i];
      if (quote) {
        if (ch === '\\') i += 1;
        else if (ch === quote) quote = null;
        continue;
      }
      if (depth > 0) {
        if (ch === '"' || ch === "'" || ch === '`') quote = ch;
        else if (ch === '{') depth += 1;
        else if (ch === '}') depth -= 1;
        continue;
      }
      if (ch === '$' && source[i + 1] === '{') { depth = 1; i += 1; continue; }
      if (ch === '"' || ch === "'") { quote = ch; continue; }
      if (ch === '>') break;
      attrs += ch;
    }
    found.push({ line: source.slice(0, m.index).split('\n').length, attrs: `${m[0]}${attrs}` });
  }
  return found;
}

const DECLARES_COLOR = /(?:^|\s)\.?color=/;

describe('pm#392: no ion-* delegates its colour to color=', () => {
  it('the source of ui/ carries no color= on an ion-* element', () => {
    const offenders = sources(UI).flatMap((file) =>
      ionTags(readFileSync(file, 'utf8'))
        .filter((t) => DECLARES_COLOR.test(t.attrs))
        .map((t) => `${path.relative(UI, file)}:${t.line}`),
    );
    expect(offenders, 'color= paints nothing inside a module shadow root').toEqual([]);
  });

  it('the reader sees a color= bound to an expression or behind an arrow function (control of the control)', () => {
    expect(ionTags('<ion-badge color=${priorityColor(p)}>x</ion-badge>').filter((t) => DECLARES_COLOR.test(t.attrs))).toHaveLength(1);
    expect(ionTags('<ion-button size="small" ?disabled=${a || b}\n  @click=${() => this.go()} color="success">x</ion-button>').filter((t) => DECLARES_COLOR.test(t.attrs))).toHaveLength(1);
    expect(ionTags('<ion-button @click=${() => ({ color: 1 })}>x</ion-button>').filter((t) => DECLARES_COLOR.test(t.attrs))).toHaveLength(0);
  });
});

// ── Render: every place that used to say `color=` now carries its tone ───────────────────────────

const TASK = {
  id: 't1',
  task_number: 'TSK-1',
  title: 'Revisar caja',
  description: '',
  project_id: null,
  status: 'todo',
  priority: 'urgent',
  assigned_to_ref: 'u-9',
  created_by_ref: null,
  due_date: null,
  completed_at: null,
  parent_task_id: null,
  tags: '',
  created_at: '2026-07-13T09:00:00',
};

beforeEach(() => {
  document.body.innerHTML = '';
  localStorage.clear();
  (globalThis as Record<string, unknown>).erplora = {
    query: async () => [],
    queryPage: async () => ({ rows: [TASK], total: 1 }),
    command: async () => ({}),
    on: () => () => {},
    locale: 'es',
    t: (_catalog: unknown, key: string) => key,
  };
});

type Wc = HTMLElement & { shadowRoot: ShadowRoot; updateComplete: Promise<unknown> } & Record<string, unknown>;

async function mount(): Promise<Wc> {
  await import('./components/erp-tasks-list/erp-tasks-list');
  const el = document.createElement('erp-tasks-list') as Wc;
  document.body.appendChild(el);
  await el.updateComplete;
  await new Promise((r) => setTimeout(r, 0));
  await el.updateComplete;
  return el;
}

const styleOf = (n: Element | null | undefined) => n?.getAttribute('style') ?? '';
const buttonWithText = (el: Wc, key: string) =>
  [...el.shadowRoot.querySelectorAll('ion-button')].find((b) => b.textContent?.trim() === key) ?? null;

/** The CSS text of the component's `static styles`, where the `tone-*` classes are painted. */
function componentCss(el: Wc): string {
  const styles = (el.constructor as unknown as { elementStyles: { cssText: string }[] }).elementStyles;
  return styles.map((s) => s.cssText).join('\n').replace(/\s+/g, ' ');
}

describe('pm#392: the detail of a task paints its chip and buttons without color=', () => {
  it('the priority chip of the detail header carries the solid tone inline (urgent → danger)', async () => {
    const el = await mount();
    el.detail = { ...TASK };
    await el.updateComplete;
    const chip = el.shadowRoot.querySelector('section.detail ion-badge');
    expect(chip, 'the detail header shows the priority chip').not.toBeNull();
    expect(chip!.hasAttribute('color')).toBe(false);
    expect(styleOf(chip)).toContain(ionTone('solid', 'danger'));
  });

  it('«Complete» is a solid success button, painted by the tone-success class', async () => {
    const el = await mount();
    el.detail = { ...TASK };
    await el.updateComplete;
    const btn = buttonWithText(el, 'ui.actionComplete');
    expect(btn, 'the detail offers «Complete»').not.toBeNull();
    expect(btn!.hasAttribute('color')).toBe(false);
    expect(btn!.hasAttribute('fill'), 'it is the solid variant').toBe(false);
    expect(btn!.classList.contains('tone-success')).toBe(true);
    const css = componentCss(el);
    expect(css).toContain('ion-button.tone-success:not([fill]) {');
    expect(css).toContain('--background: var(--ion-color-success, #2dd55b)');
    expect(css).toContain('--color: var(--ion-color-success-contrast, #000)');
  });

  it('«Unassign» is an outline button in the medium tone, painted by the tone-medium class', async () => {
    const el = await mount();
    el.detail = { ...TASK };
    await el.updateComplete;
    const btn = buttonWithText(el, 'ui.actionUnassign');
    expect(btn, 'an assigned task offers «Unassign»').not.toBeNull();
    expect(btn!.hasAttribute('color')).toBe(false);
    expect(btn!.getAttribute('fill')).toBe('outline');
    expect(btn!.classList.contains('tone-medium')).toBe(true);
    const css = componentCss(el);
    expect(css).toContain('ion-button.tone-medium[fill] {');
    expect(css).toContain('--color: var(--ion-color-medium, #636469)');
    expect(css).toContain('--border-color: var(--ion-color-medium, #636469)');
  });
});
