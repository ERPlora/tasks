// Contrato de la BARRA de la lista de proyectos de tareas.
//
// El alta de un proyecto vive DENTRO de `ok-data-table`, detrás del «+» de su barra (panel
// `slot="create"`), como en /employees del core y en el CRUD de productos de `inventory`; no en un
// `<form>` suelto encima de la tabla. Tras crear con éxito, el panel se cierra solo. Los filtros
// van dentro de la tabla, y «activo» —dominio cerrado (sí/no)— se elige con un `select`.
import { beforeEach, describe, expect, it } from 'vitest';

const PROYECTO = { id: 'p1', code: 'q3-audit', name: 'Auditoría Q3', color: '#ff0000', is_active: 1 };

const comandos: { name: string; payload: Record<string, unknown> }[] = [];

beforeEach(() => {
  comandos.length = 0;
  (globalThis as Record<string, unknown>).erplora = {
    query: async () => [],
    queryPage: async () => ({ rows: [PROYECTO], total: 1 }),
    command: async (name: string, payload: Record<string, unknown>) => {
      comandos.push({ name, payload });
      return {};
    },
    on: () => () => {},
    locale: 'es',
    t: (_catalog: unknown, key: string) => key,
  };
});

async function montar() {
  await import('./erp-tasks-projects');
  const el = document.createElement('erp-tasks-projects');
  document.body.appendChild(el);
  await (el as unknown as { updateComplete: Promise<unknown> }).updateComplete;
  await new Promise((r) => setTimeout(r, 0));
  await (el as unknown as { updateComplete: Promise<unknown> }).updateComplete;
  return el as HTMLElement & { shadowRoot: ShadowRoot };
}

const tabla = (el: HTMLElement & { shadowRoot: ShadowRoot }) =>
  el.shadowRoot.querySelector('ok-data-table') as (HTMLElement & { addable: boolean; fill: boolean; close: () => void }) | null;

describe('el alta vive DENTRO de la tabla (paridad con /employees e inventory)', () => {
  it('la tabla declara `addable` → pinta el «+» en su barra', async () => {
    const el = await montar();
    expect(tabla(el)?.addable, 'sin `addable` no hay «+» en la barra de la tabla').toBe(true);
  });

  it('la tabla llena el alto del contenedor (`fill`): scroll interno, pager fijo', async () => {
    const el = await montar();
    expect(tabla(el)?.fill).toBe(true);
  });

  it('el formulario de alta se proyecta en el panel `create` de la tabla', async () => {
    const el = await montar();
    const form = el.shadowRoot.querySelector('form[slot="create"]');
    expect(form, 'el formulario de alta no está en el slot `create`').toBeTruthy();
    expect(form?.closest('ok-data-table'), 'el formulario de alta cuelga fuera de la tabla').toBeTruthy();
  });

  it('no queda NINGÚN control de alta suelto fuera de la tabla', async () => {
    const el = await montar();
    const sueltos = [...el.shadowRoot.querySelectorAll('form, ion-input, ion-select, ion-button')].filter(
      (n) => !n.closest('ok-data-table'),
    );
    expect(sueltos.map((n) => n.tagName.toLowerCase()), 'hay controles de alta fuera de la tabla').toEqual([]);
  });
});

describe('los filtros de dominio cerrado son `select`', () => {
  it('«activo» se filtra eligiendo sí/no', async () => {
    const el = await montar();
    const cols = (el as unknown as { columns: { key: string; filterType?: string; options?: unknown[] }[] }).columns;
    const activo = cols.find((c) => c.key === 'is_active');
    expect(activo?.filterType).toBe('select');
    expect(activo?.options?.length).toBe(2);
  });
});

describe('el alta sigue funcionando desde el panel', () => {
  it('crear manda tasks.projects.create y CIERRA el panel de la tabla', async () => {
    const el = await montar();
    const t = tabla(el)!;
    let cerrado = 0;
    t.close = () => {
      cerrado += 1;
    };

    const wc = el as unknown as { newCode: string; newName: string; newColor: string; createProject: (ev: Event) => Promise<void> };
    wc.newCode = 'q3-audit';
    wc.newName = 'Auditoría Q3';
    wc.newColor = '#ff0000';
    await wc.createProject(new Event('submit'));

    const alta = comandos.find((c) => c.name === 'tasks.projects.create');
    expect(alta, 'no se mandó el alta del proyecto').toBeTruthy();
    expect(alta!.payload.code).toBe('q3-audit');
    expect(alta!.payload.name).toBe('Auditoría Q3');
    expect(cerrado, 'el panel de alta se queda abierto tras crear').toBe(1);
  });
});
