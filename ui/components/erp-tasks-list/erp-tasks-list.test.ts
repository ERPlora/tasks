// Contrato de la BARRA de la lista de tareas.
//
// El alta de una tarea vive DENTRO de `ok-data-table`, detrás del «+» de su barra de herramientas
// (panel `slot="create"`), como en /employees del core y en el CRUD de productos de `inventory`.
// Nada de un `<form>` suelto flotando encima de la tabla. Tras crear con éxito el panel se cierra
// solo. Los filtros van dentro de la tabla y los de dominio cerrado (estado, prioridad — el enum
// de la migración) se eligen con un `select`, no tecleando el valor a mano.
//
// El detalle de una tarea (comentarios, subtareas, asignación) NO es alta de fila de esta tabla:
// se queda donde está, fuera del panel.
import { beforeEach, describe, expect, it } from 'vitest';

const TAREA = {
  id: 't1',
  task_number: 'TSK-1',
  title: 'Revisar caja',
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

const comandos: { name: string; payload: Record<string, unknown> }[] = [];

beforeEach(() => {
  comandos.length = 0;
  localStorage.clear();
  (globalThis as Record<string, unknown>).erplora = {
    query: async () => [],
    queryPage: async () => ({ rows: [TAREA], total: 1 }),
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
  await import('./erp-tasks-list');
  const el = document.createElement('erp-tasks-list');
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
  it('estado y prioridad se filtran eligiendo del enum de la migración, no tecleando', async () => {
    const el = await montar();
    const cols = (el as unknown as { columns: { key: string; filterType?: string; options?: unknown[] }[] }).columns;
    for (const key of ['status', 'priority']) {
      const col = cols.find((c) => c.key === key);
      expect(col?.filterType, `${key} se filtra con texto libre`).toBe('select');
      expect(col?.options?.length, `el select de ${key} no ofrece opciones`).toBeGreaterThan(0);
    }
  });
});

describe('el alta sigue funcionando desde el panel', () => {
  it('crear manda tasks.tasks.create y CIERRA el panel de la tabla', async () => {
    const el = await montar();
    const t = tabla(el)!;
    let cerrado = 0;
    t.close = () => {
      cerrado += 1;
    };

    const wc = el as unknown as { newTitle: string; newPriority: string; createTask: (ev: Event) => Promise<void> };
    wc.newTitle = 'Revisar caja';
    wc.newPriority = 'high';
    await wc.createTask(new Event('submit'));

    const alta = comandos.find((c) => c.name === 'tasks.tasks.create');
    expect(alta, 'no se mandó el alta de la tarea').toBeTruthy();
    expect(alta!.payload.title).toBe('Revisar caja');
    expect(alta!.payload.priority).toBe('high');
    expect(cerrado, 'el panel de alta se queda abierto tras crear').toBe(1);
  });
});
