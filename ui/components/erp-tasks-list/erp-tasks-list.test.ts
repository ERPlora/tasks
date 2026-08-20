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

// La CELDA se pinta con `format`; sin él `ok-data-table` cae al valor crudo de la fila. Y como la
// vista de tarjetas (móvil) usa ESE MISMO `format`, arreglar la columna arregla los dos viewports.
// El `t` de las pruebas devuelve la CLAVE, así que «pasó por i18n» se comprueba viendo la clave
// (`ui.priority.high`) donde antes salía el enum crudo (`high`).
type Col = { key: string; format?: (row: Record<string, unknown>) => string };

const celda = (el: HTMLElement & { shadowRoot: ShadowRoot }, key: string, row: Record<string, unknown>) => {
  const col = ((el as unknown as { columns: Col[] }).columns).find((c) => c.key === key);
  expect(col, `no existe la columna ${key}`).toBeTruthy();
  // Sin `format` la tabla pinta `row[key]` tal cual: eso es exactamente el defecto de tasks#23.
  return col!.format ? col!.format(row) : String(row[key] ?? '');
};

describe('las columnas se leen en el idioma del hub, no en crudo (tasks#23)', () => {
  it('PRIORIDAD pasa por i18n, igual que ESTADO en esta misma tabla', async () => {
    const el = await montar();
    for (const priority of ['low', 'medium', 'high', 'urgent']) {
      const pintado = celda(el, 'priority', { ...TAREA, priority });
      expect(pintado, `la prioridad se pinta con el enum crudo «${priority}»`).toBe(`ui.priority.${priority}`);
    }
  });

  it('ESTADO sigue traducido (no romper lo que ya estaba bien)', async () => {
    const el = await montar();
    expect(celda(el, 'status', { ...TAREA, status: 'done' })).toBe('ui.status.done');
  });

  it('VENCE se pinta en formato local, no en ISO', async () => {
    const el = await montar();
    const pintado = celda(el, 'due_date', { ...TAREA, due_date: '2026-09-01T00:00:00+00:00' });
    expect(pintado, 'el vencimiento sigue saliendo en ISO').not.toContain('2026-09-01');
    expect(pintado, 'en es-ES se escribe 01/09/2026').toBe('01/09/2026');
  });

  it('sin vencimiento se pinta un guion', async () => {
    const el = await montar();
    expect(celda(el, 'due_date', { ...TAREA, due_date: null })).toBe('—');
  });

  // 🔴 La trampa que avisaba la issue. La query devuelve el vencimiento como datetime COMPLETO
  // (`2026-09-01T00:00:00+00:00`) aunque el schema del alta acepte `YYYY-MM-DD`. Formatearlo con el
  // huso del NAVEGADOR hace que una fecha guardada a las 00:00 UTC retroceda un día al oeste de
  // Greenwich: el usuario ve tareas que vencen el día antes del que puso. Se comprueba de verdad,
  // moviendo el huso del proceso — sin esto la prueba pasaría también con la versión ingenua.
  it('un vencimiento a las 00:00 UTC NO retrocede un día en un huso al oeste', async () => {
    const tz = process.env.TZ;
    process.env.TZ = 'America/Los_Angeles';
    try {
      // Control: que el huso esté REALMENTE movido, o esta prueba no comprueba nada.
      expect(new Date('2026-09-01T00:00:00+00:00').getTimezoneOffset(), 'el huso no se movió').toBeGreaterThan(0);
      const el = await montar();
      expect(
        celda(el, 'due_date', { ...TAREA, due_date: '2026-09-01T00:00:00+00:00' }),
        'el vencimiento retrocede un día: se está convirtiendo de huso una fecha pura',
      ).toBe('01/09/2026');
    } finally {
      process.env.TZ = tz;
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
