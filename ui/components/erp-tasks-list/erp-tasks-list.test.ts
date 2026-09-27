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
import { render } from 'lit';
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
type Col = {
  key: string;
  format?: (row: Record<string, unknown>) => string;
  /** Render de celda a medida (tasks#29): `ok-data-table` le da prioridad sobre `format` y lo usan
   *  igual la tabla y la vista de tarjetas, así que los dos viewports salen a la vez. */
  render?: (row: Record<string, unknown>) => unknown;
};

const columnas = (el: HTMLElement & { shadowRoot: ShadowRoot }) => (el as unknown as { columns: Col[] }).columns;

const celda = (el: HTMLElement & { shadowRoot: ShadowRoot }, key: string, row: Record<string, unknown>) => {
  const col = columnas(el).find((c) => c.key === key);
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

// ── tasks#29: la prioridad se ve, no se lee ────────────────────────────────────────────────────
//
// La prioridad es la columna por la que se ordena el trabajo del día, y con las cuatro etiquetas
// en texto plano («Baja / Media / Alta / Urgente») todas pesan lo mismo: hay que LEER cuatro
// palabras parecidas fila a fila. Todos los gestores de tareas del mercado —Odoo Proyecto, Asana,
// Trello, Monday, Jira y las listas de tareas de Business Central— pintan la prioridad con color y
// el vencimiento pasado en rojo. No hay nada que inventar.
//
// Se comprueba sobre el `render` de la columna (`ok-data-table` le da prioridad sobre `format` y lo
// usan IGUAL la tabla y la vista de tarjetas, así que móvil y escritorio salen a la vez), y se
// exige que el color NO sea el único portador: el texto traducido sigue ahí (daltonismo), y los
// colores son tokens de Ionic, no hexadecimales sueltos, para que respeten claro/oscuro.
describe('la PRIORIDAD se pinta como chip de color (tasks#29)', () => {
  /** El HTML que la columna pinta de verdad para esa fila. */
  const pintado = (el: HTMLElement & { shadowRoot: ShadowRoot }, key: string, row: Record<string, unknown>) => {
    const col = columnas(el).find((c) => c.key === key);
    expect(col?.render, `la columna «${key}» no tiene render: sigue pintando texto plano`).toBeTypeOf('function');
    const host = document.createElement('div');
    render(col!.render!(row) as never, host);
    return host;
  };

  it('cada prioridad sale como chip, y las cuatro se distinguen por color', async () => {
    const el = await montar();
    const colores = new Map<string, string>();
    for (const priority of ['low', 'medium', 'high', 'urgent']) {
      const chip = pintado(el, 'priority', { ...TAREA, priority }).querySelector('ion-badge');
      expect(chip, `la prioridad «${priority}» no se pinta como chip`).toBeTruthy();
      // pm#392: the tone travels INLINE (`--background` from the token). `color=` painted nothing
      // here: Ionic resolves it through a global rule that never reaches the table's shadow root.
      expect(chip!.hasAttribute('color'), `«${priority}» still delegates to color=`).toBe(false);
      const color = /--background: var\(--ion-color-([a-z]+),/.exec(chip!.getAttribute('style') ?? '')?.[1] ?? '';
      expect(color, `«${priority}» no lleva color`).not.toBe('');
      colores.set(priority, color);
    }
    expect(new Set(colores.values()).size, `dos prioridades comparten color: ${[...colores]}`).toBe(4);
    // Escalada: lo urgente es el rojo del sistema, lo bajo se retira. Si esto se invierte, la
    // lista miente de un vistazo, que es justo lo que se venía a arreglar.
    expect(colores.get('urgent')).toBe('danger');
    expect(colores.get('high')).toBe('warning');
    expect(colores.get('low')).toBe('medium');
  });

  it('el color NO es el único portador: el texto traducido sigue dentro del chip (daltonismo)', async () => {
    const el = await montar();
    for (const priority of ['low', 'medium', 'high', 'urgent']) {
      const chip = pintado(el, 'priority', { ...TAREA, priority }).querySelector('ion-badge');
      expect(chip!.textContent?.trim(), `«${priority}» pinta un chip mudo`).toBe(`ui.priority.${priority}`);
    }
  });

  it('la columna conserva su `format` de texto (búsqueda, exportación, tarjetas sin render)', async () => {
    const el = await montar();
    expect(celda(el, 'priority', { ...TAREA, priority: 'high' })).toBe('ui.priority.high');
  });
});

describe('el VENCIMIENTO pasado se ve en rojo (tasks#29)', () => {
  const HOY = new Date();
  const iso = (offsetDays: number) => {
    const d = new Date(HOY.getFullYear(), HOY.getMonth(), HOY.getDate() + offsetDays);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const celdaVence = (el: HTMLElement & { shadowRoot: ShadowRoot }, row: Record<string, unknown>) => {
    const col = columnas(el).find((c) => c.key === 'due_date');
    expect(col?.render, 'la columna «Vence» no tiene render: no puede pintar nada en rojo').toBeTypeOf('function');
    const host = document.createElement('div');
    render(col!.render!(row) as never, host);
    return host.querySelector('span') as HTMLElement;
  };

  it('un vencimiento pasado se distingue en rojo SIN romper el formato 01/09/2026', async () => {
    const el = await montar();
    const celdaHTML = celdaVence(el, { ...TAREA, due_date: '2020-09-01' });
    expect(celdaHTML.textContent, 'se perdió la fecha en formato local').toContain('01/09/2020');
    expect(celdaHTML.getAttribute('style') ?? '', 'la fecha vencida no va en el rojo del sistema')
      .toContain('--ion-color-danger');
  });

  it('el rojo no es el único portador: la celda vencida se anuncia también con texto', async () => {
    const el = await montar();
    const celdaHTML = celdaVence(el, { ...TAREA, due_date: '2020-09-01' });
    expect(celdaHTML.getAttribute('title') ?? celdaHTML.getAttribute('aria-label') ?? '').toBe('ui.overdue');
  });

  it('lo que vence HOY se matiza, pero no como vencido', async () => {
    const el = await montar();
    const estilo = celdaVence(el, { ...TAREA, due_date: iso(0) }).getAttribute('style') ?? '';
    expect(estilo, 'lo de hoy se pinta como si ya estuviera vencido').not.toContain('--ion-color-danger');
    expect(estilo, 'lo de hoy no se distingue en nada').toContain('--ion-color-warning');
  });

  it('un vencimiento futuro y una tarea sin fecha se quedan en el color normal', async () => {
    const el = await montar();
    expect(celdaVence(el, { ...TAREA, due_date: iso(30) }).getAttribute('style') ?? '').toBe('');
    expect(celdaVence(el, { ...TAREA, due_date: null }).textContent).toBe('—');
  });

  // Una tarea cerrada no está «vencida»: ya no hay nada que hacer con ella y teñir la lista de rojo
  // por tareas hechas es ruido, no aviso. Es lo que hacen Asana, Jira y Todoist.
  it('una tarea ya HECHA o cancelada no se pinta en rojo aunque su fecha haya pasado', async () => {
    const el = await montar();
    for (const status of ['done', 'cancelled']) {
      const estilo = celdaVence(el, { ...TAREA, status, due_date: '2020-09-01' }).getAttribute('style') ?? '';
      expect(estilo, `una tarea «${status}» se sigue pintando como vencida`).not.toContain('--ion-color-danger');
    }
  });
});

// ── pm#155 (outfitkit#67, second half) ────────────────────────────────────────────────────────
//
// At 1440 px the «Actions» column fell off the screen with nothing hinting the table went on to
// the right, so the only door into a task was a button nobody could see. OutfitKit 0.1.44 pins
// that column, but the other half of the fix is opt-in: `rowClickable` turns the whole row into a
// door — the first thing a user tries. The list has to ask for it, and wire `rowClick` to the
// same detail the «detail» action opens. BOTH tables (all + mine) are doors.
describe('clicking the row opens the task (pm#155)', () => {
  const tabla = (el: HTMLElement & { shadowRoot: ShadowRoot }, i = 0) =>
    el.shadowRoot.querySelectorAll('ok-data-table')[i] as (HTMLElement & { rowClickable: boolean }) | undefined;

  it('the «all» table declares `rowClickable` → the whole row is a door, not just the action button', async () => {
    const el = await montar();
    expect(
      tabla(el)?.rowClickable,
      'without `rowClickable` the row is dead: if the actions column is off-screen there is no way in',
    ).toBe(true);
  });

  it('`rowClick` on the «all» table opens the detail, same as the «detail» action', async () => {
    const sdk = (globalThis as Record<string, unknown>).erplora as Record<string, unknown>;
    sdk.query = async (name: string) => (name === 'tasks.tasks.get' ? [TAREA] : []);
    const el = await montar();
    tabla(el)!.dispatchEvent(new CustomEvent('rowClick', { detail: { row: TAREA } }));
    await new Promise((r) => setTimeout(r, 0));
    await (el as unknown as { updateComplete: Promise<unknown> }).updateComplete;
    expect(
      el.shadowRoot.querySelector('section.detail'),
      'the row was clicked and the detail did not open',
    ).toBeTruthy();
  });

  it('the «mine» table declares `rowClickable` too (it has the same «detail» action)', async () => {
    localStorage.setItem('erplora.session', JSON.stringify({ id: 'u1' }));
    const el = await montar();
    const wc = el as unknown as { setView(v: 'all' | 'mine'): void; updateComplete: Promise<unknown> };
    wc.setView('mine');
    await wc.updateComplete;
    await new Promise((r) => setTimeout(r, 0));
    await wc.updateComplete;
    expect(
      tabla(el)?.rowClickable,
      'the «mine» table renders the same rows with the same dead row problem',
    ).toBe(true);
  });
});

// ── tasks#42 ──────────────────────────────────────────────────────────────────────────────────
//
// `author_ref` and `assigned_to_ref` are the ids of the hub's people (`hub_user.id`). The detail
// painted them raw: every comment signed «3f2a… · 2026-09-26 23:44», «Assigned to: 3f2a…» and an
// «Assign to» box asking for a uuid. The names come from `hub.users.list`, the core's reserved
// namespace (ADR-0192) — the same door `tickets`, `kitchen` and `sales` use. An id the hub no longer
// lists, or a list that could not be loaded, paints a readable text: never the id.
describe('the task detail names people, never their internal id (tasks#42)', () => {
  const ANA = 'a1b2c3d4-0000-4000-8000-000000000001';
  const LUIS = 'a1b2c3d4-0000-4000-8000-000000000002';
  const GONE = 'a1b2c3d4-0000-4000-8000-00000000dead';
  const PEOPLE = [
    { id: ANA, name: 'Ana García', role: 'admin', is_active: true },
    { id: LUIS, name: 'Luis Pérez', role: 'employee', is_active: true },
  ];

  async function open(
    assigned: string | null,
    comments: Record<string, unknown>[] = [],
    people: () => Promise<unknown> = async () => PEOPLE,
  ) {
    const sdk = (globalThis as Record<string, unknown>).erplora as Record<string, unknown>;
    const task = { ...TAREA, assigned_to_ref: assigned };
    sdk.query = async (name: string) => {
      if (name === 'tasks.tasks.get') return [task];
      if (name === 'tasks.tasks.comments') return comments;
      if (name === 'hub.users.list') return people();
      return [];
    };
    const el = await montar();
    const wc = el as unknown as { openDetail: (t: unknown) => void; updateComplete: Promise<unknown> };
    wc.openDetail(task);
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    await wc.updateComplete;
    comandos.length = 0;
    return { el, wc };
  }

  const detail = (el: HTMLElement & { shadowRoot: ShadowRoot }) => el.shadowRoot.querySelector('section.detail');
  const assignedTo = (el: HTMLElement & { shadowRoot: ShadowRoot }) =>
    [...el.shadowRoot.querySelectorAll('.meta span')].find((s) => s.textContent?.includes('ui.assignedToLabel'))
      ?.textContent ?? '';
  const authors = (el: HTMLElement & { shadowRoot: ShadowRoot }) =>
    [...el.shadowRoot.querySelectorAll('.comment .who .author')].map((s) => s.textContent?.trim());
  const picker = (el: HTMLElement & { shadowRoot: ShadowRoot }) =>
    el.shadowRoot.querySelector('[data-testid="tasks-list-assign-ref"]');
  const pickerLabels = (el: HTMLElement & { shadowRoot: ShadowRoot }) =>
    [...(picker(el)?.querySelectorAll('ion-select-option') ?? [])].map((o) => o.textContent?.trim());
  const comment = (id: string, author_ref: string | null) => ({
    id,
    task_id: 't1',
    author_ref,
    comment: 'hola',
    created_at: '2026-09-26T23:44:00',
  });

  it('each comment is signed by the name of its author, followed by its date', async () => {
    const { el } = await open(null, [comment('c1', LUIS)]);
    expect(authors(el)).toEqual(['Luis Pérez']);
    const who = el.shadowRoot.querySelector('.comment .who')?.textContent ?? '';
    expect(who, 'the internal id leaks into the comment signature').not.toContain(LUIS);
    expect(who).toContain('2026-09-26 23:44');
  });

  it('an author the hub no longer lists reads as a text, not as the id; a comment without author stays anonymous', async () => {
    const { el } = await open(null, [comment('c1', ANA), comment('c2', GONE), comment('c3', null)]);
    expect(authors(el)).toEqual(['Ana García', 'ui.unknownPerson', 'ui.anonymous']);
    expect(detail(el)?.textContent).not.toContain(GONE);
  });

  it('«Assigned to» shows the name of the person the task is assigned to', async () => {
    const { el } = await open(ANA);
    expect(assignedTo(el)).toContain('Ana García');
    expect(assignedTo(el), 'the internal id leaks into «Assigned to»').not.toContain(ANA);
  });

  it('an assignee the hub no longer lists reads as a text, not as the id', async () => {
    const { el } = await open(GONE);
    expect(assignedTo(el)).toContain('ui.unknownPerson');
    expect(assignedTo(el)).not.toContain(GONE);
  });

  it('an unassigned task says so', async () => {
    const { el } = await open(null);
    expect(assignedTo(el)).toContain('ui.unassigned');
  });

  it('if the people cannot be loaded the detail still opens and shows no id anywhere', async () => {
    const { el } = await open(ANA, [comment('c1', ANA)], async () => {
      throw new Error('forbidden');
    });
    expect(detail(el), 'the detail did not open').toBeTruthy();
    expect(detail(el)?.textContent, 'an id leaked').not.toContain(ANA);
    expect(assignedTo(el)).toContain('ui.unknownPerson');
    expect(authors(el)).toEqual(['ui.unknownPerson']);
  });

  it('a person listed with a blank name reads as unknown, and is not offered in the picker', async () => {
    const { el } = await open(ANA, [comment('c1', ANA)], async () => [{ id: ANA, name: '   ', is_active: true }]);
    expect(assignedTo(el)).toContain('ui.unknownPerson');
    expect(authors(el)).toEqual(['ui.unknownPerson']);
    expect(pickerLabels(el)).toEqual([]);
  });

  it('«Assign to» is a picker of the hub people by name, not a box to type a uuid', async () => {
    const { el } = await open(null);
    const agent = picker(el);
    expect(agent?.tagName.toLowerCase(), '«Assign to» is still a free-text box').toBe('ion-select');
    const options = [...(agent?.querySelectorAll('ion-select-option') ?? [])].map((o) => ({
      value: (o as unknown as { value: string }).value,
      label: o.textContent?.trim(),
    }));
    expect(options).toEqual([
      { value: ANA, label: 'Ana García' },
      { value: LUIS, label: 'Luis Pérez' },
    ]);
  });

  it('the picker lists the people alphabetically, whatever order the hub returns them in', async () => {
    const { el } = await open(null, [], async () => [PEOPLE[1], PEOPLE[0]]);
    expect(pickerLabels(el)).toEqual(['Ana García', 'Luis Pérez']);
  });

  it('a person who is no longer active is not offered as a new assignee, but the detail still names them', async () => {
    const people = async () => [...PEOPLE, { id: GONE, name: 'Old Timer', is_active: false }];
    const { el } = await open(null, [], people);
    expect(pickerLabels(el)).not.toContain('Old Timer');
    const again = await open(GONE, [comment('c1', GONE)], people);
    expect(assignedTo(again.el)).toContain('Old Timer');
    expect(authors(again.el)).toEqual(['Old Timer']);
  });

  it('with nobody to choose, «Assign to» says so and cannot be opened', async () => {
    const { el } = await open(null, [], async () => []);
    const agent = picker(el);
    expect(agent?.hasAttribute('disabled'), 'an empty picker can still be opened').toBe(true);
    expect(agent?.getAttribute('placeholder')).toBe('ui.noPeople');
  });

  it('with people to choose, «Assign to» invites to pick one', async () => {
    const { el } = await open(null);
    expect(picker(el)?.hasAttribute('disabled')).toBe(false);
    expect(picker(el)?.getAttribute('placeholder')).toBe('ui.pickPersonPlaceholder');
  });

  it('picking a person and pressing «Assign» sends their id, not their name', async () => {
    const { el } = await open(null);
    const agent = picker(el) as HTMLElement & { value: string };
    agent.value = LUIS;
    agent.dispatchEvent(new CustomEvent('ionChange', { detail: { value: LUIS } }));
    await (el as unknown as { updateComplete: Promise<unknown> }).updateComplete;
    (el.shadowRoot.querySelector('[data-testid="tasks-list-assign-submit"]') as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 0));
    const sent = comandos.filter((c) => c.name === 'tasks.tasks.assign');
    expect(sent.map((c) => c.payload)).toEqual([{ task_id: 't1', assigned_to_ref: LUIS }]);
  });

  it('an assigned task opens with its assignee already chosen in «Assign to»', async () => {
    const { el } = await open(LUIS);
    expect((picker(el) as unknown as { value: string }).value).toBe(LUIS);
    const submit = el.shadowRoot.querySelector('[data-testid="tasks-list-assign-submit"]');
    expect(submit?.hasAttribute('disabled')).toBe(false);
  });

  it('«Assign» cannot be pressed until someone is picked', async () => {
    const { el } = await open(null);
    const submit = el.shadowRoot.querySelector('[data-testid="tasks-list-assign-submit"]');
    expect(submit?.hasAttribute('disabled'), '«Assign» with nobody picked would unassign by accident').toBe(true);
  });
});
