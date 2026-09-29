// tasks#43 (rv-tasks-49) — the project sheet opens ABOVE the list and never shrinks (up to 70vh),
// so the list was the flex child that gave (`min-height: 0`). From 641 px the `fill` data-table fits
// its rows inside its own box: on a 1440×900 screen, with the sheet open, the list was down to its
// toolbar and half a row (kitchen#131 is the same defect on Kitchen › Stations).
//
// The fix gives the table the floor kitchen#132 and the showcase demo carry (`min-height: 20rem`):
// when the sheet fills the screen, the PAGE scrolls and the list keeps its rows. happy-dom does no
// layout, so what is pinned here is the rule that makes it possible; the rows on screen were
// measured in a real browser.
import { describe, expect, it } from 'vitest';

const SIZING = ['flex', 'flex-grow', 'flex-shrink', 'flex-basis', 'height', 'min-height', 'max-height'];
const TABLE = '.page > ok-data-table';

(globalThis as Record<string, unknown>).erplora ??= { t: (_c: unknown, k: string) => k, locale: 'en' };

/** Every sizing declaration that lands on ok-data-table, in source order, from ALL of Lit's rules
 *  (inside `@media` too): a later rule or an `!important` undoes the floor (HALLAZGO rv-kitchen-132). */
async function tableSizing(): Promise<{ selector: string; prop: string; value: string }[]> {
  const { ErpTasksProjects } = await import('./erp-tasks-projects');
  const styles = ([] as unknown[]).concat((ErpTasksProjects as unknown as { styles: unknown }).styles);
  const css = styles.map((s) => String((s as { cssText?: string }).cssText ?? '')).join('\n');
  const flat = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: { selector: string; prop: string; value: string }[] = [];
  for (const [, selectors, body] of flat.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    for (const raw of selectors.split(',')) {
      const selector = raw.trim().replace(/\s*>\s*/g, ' > ').replace(/\s+/g, ' ');
      if (!/(^|[\s>+~])ok-data-table(?![\w-])[^\s>+~]*$/.test(selector)) continue;
      for (const decl of body.split(';')) {
        const at = decl.indexOf(':');
        const prop = decl.slice(0, at).trim();
        if (at > 0 && SIZING.includes(prop)) out.push({ selector, prop, value: decl.slice(at + 1).trim() });
      }
    }
  }
  return out;
}

describe('the projects list keeps a floor while a project sheet is open (tasks#43)', () => {
  it('the table grows into the free height but never below ~20 rows of text', async () => {
    const sizing = await tableSizing();
    expect(sizing.filter((d) => d.selector !== TABLE), 'sizing of ok-data-table outside its rule').toEqual([]);
    const last = (prop: string) => sizing.filter((d) => d.prop === prop).at(-1)?.value;
    expect(last('flex'), 'the table still takes the height the sheet leaves').toBe('1 1 auto');
    for (const prop of ['flex-grow', 'flex-shrink', 'flex-basis', 'height', 'max-height']) {
      expect(last(prop), `${prop} would cap or squeeze the table`).toBeUndefined();
    }
    const floor = last('min-height') ?? '';
    expect(floor, `table floor ${floor}`).toMatch(/^\d+(?:\.\d+)?rem$/);
    expect(parseFloat(floor), `table floor ${floor}`).toBeGreaterThanOrEqual(15);
  });
});
