import { LitElement, html, css, nothing } from 'lit';
import type { PropertyValues } from 'lit';
import { state } from 'lit/decorators.js';
import { define } from '@erplora/outfitkit/define';
import '@erplora/outfitkit/ok-data-table';
import type { DataTableColumn } from '@erplora/outfitkit';
import { createListController } from '@erplora/module-sdk';
import type { ListController, ListClient, ListParams, ListPage } from '@erplora/module-sdk';
import { ionTone, type IonTone } from '../../lib/ion-tone';
// Catálogo i18n del módulo (ADR-0055): esbuild inlinea estos JSON en el `dist` del WC. Los textos
// internos se resuelven con `erplora.t(CATALOG, 'ui.clave')` (idioma activo, fallback locale→en→clave).
import esLocale from '../../../locales/es.json';
import enLocale from '../../../locales/en.json';
const CATALOG: Record<string, unknown> = { es: esLocale, en: enLocale };

interface ErploraClientLike extends ListClient {
  query<T = unknown>(name: string, params?: Record<string, unknown>): Promise<T>;
  queryPage<R = unknown>(name: string, params: ListParams): Promise<ListPage<R>>;
  command<T = unknown>(name: string, payload?: Record<string, unknown>): Promise<T>;
  on(event: string, cb: (payload: unknown) => void): () => void;
  /** i18n del módulo (ADR-0055): idioma activo + traducción del catálogo `ui`. */
  locale: string;
  t(catalog: Record<string, unknown>, key: string, params?: Record<string, unknown>): string;
  /** The shell's toast. Optional: a preview without the SDK has none. */
  notify?(n: { type: 'success' | 'error' | 'info' | 'warning'; message: string }): void;
}

interface Task {
  id: string;
  task_number: string;
  title: string;
  description: string;
  project_id: string | null;
  status: string;
  priority: string;
  assigned_to_ref: string | null;
  created_by_ref: string | null;
  due_date: string | null;
  completed_at: string | null;
  parent_task_id: string | null;
  tags: string;
  created_at: string;
}

interface TaskComment {
  id: string;
  task_id: string;
  author_ref: string | null;
  comment: string;
  created_at: string;
}

/** One row of `hub.users.list` — the hub's people (ADR-0192, the core's reserved namespace).
 *  `assigned_to_ref` and `author_ref` are these ids; the name is presentation, resolved here
 *  (tasks#42), the same door `tickets`, `kitchen` and `sales` use. */
interface HubPerson {
  id: string;
  name: string;
  is_active?: boolean;
}

// Valores de enum (claves): NO se traducen. Las etiquetas visibles se resuelven por i18n.
const STATUS_VALUES = ['todo', 'in_progress', 'blocked', 'done', 'cancelled'] as const;
const PRIORITY_VALUES = ['low', 'medium', 'high', 'urgent'] as const;

/** Traducción del catálogo `ui` (idioma activo, fallback locale→en→clave). */
function t(key: string, params?: Record<string, unknown>): string {
  return erplora().t(CATALOG, key, params);
}

function statusLabel(status: string): string {
  return t(`ui.status.${status}`);
}

function priorityLabel(priority: string): string {
  return t(`ui.priority.${priority}`);
}

// ── Priority and due-date colour (tasks#29) ──────────────────────────────────
//
// Priority is the column the day's work is sorted by, and with the four labels in plain text they all
// weigh the same: you have to READ four similar words row by row. Odoo Project, Asana, Trello, Monday,
// Jira and Business Central's task lists all do the same — colour for priority, past due in red — so
// there is nothing to invent.
//
// It is painted as an `ion-badge` with Ionic TOKENS (`--ion-color-*`), not hex values: the chip follows
// the light/dark theme and the palette guarantees its AA contrast. And colour is NEVER the only carrier:
// the translated label stays inside the chip (colour blindness). The tone goes INLINE through
// `ionTone`, never through `color=` (pm#392): the chip lives inside `ok-data-table`'s shadow root,
// where neither Ionic's global `.ion-color-*` rule nor a class of this component arrives.

/** Standard escalation: urgent is the system red and low steps back. */
const PRIORITY_COLOR: Record<string, IonTone> = {
  low: 'medium',
  medium: 'primary',
  high: 'warning',
  urgent: 'danger',
};

function priorityColor(priority: string): IonTone {
  return PRIORITY_COLOR[priority] ?? 'medium';
}

/** Hoy en el huso del USUARIO, `YYYY-MM-DD`. Se compara texto con texto contra `due_date` (que es
 *  una fecha pura) para no repetir el fallo de tasks#23: convertir de huso una fecha sin hora la
 *  hace retroceder un día al oeste de Greenwich. */
function todayIso(now: Date = new Date()): string {
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

/** `overdue` | `today` | `none`. Una tarea CERRADA no está vencida: ya no hay nada que hacer con
 *  ella, y teñir la lista de rojo por tareas hechas es ruido, no aviso (Asana, Jira, Todoist). */
function dueTone(due: string | null | undefined, status: string, now?: Date): 'overdue' | 'today' | 'none' {
  if (!due) return 'none';
  if (status === 'done' || status === 'cancelled') return 'none';
  const day = /^(\d{4}-\d{2}-\d{2})/.exec(String(due))?.[1];
  if (!day) return 'none';
  const today = todayIso(now);
  if (day < today) return 'overdue';
  if (day === today) return 'today';
  return 'none';
}

/**
 * tasks#45 · «My tasks» only lists OPEN tasks, so the one just completed vanished on the reload and
 * the next card slid into its slot. It stays where it was, shown as done, until the person leaves the
 * tab (Things, Apple Reminders, Asana): the fresh rows keep the server's order and each kept task goes
 * back right after the card that preceded it. A kept task the server lists again (reopened) is
 * painted from the server, once.
 */
export function keepCompletedInPlace<T extends { id: string }>(previous: T[], fresh: T[], kept: Map<string, T>): T[] {
  const result = [...fresh];
  const has = (id: string): boolean => result.some((r) => r.id === id);
  previous.forEach((row, i) => {
    const done = kept.get(row.id);
    if (!done || has(row.id)) return;
    let at = 0;
    for (let j = i - 1; j >= 0; j--) {
      const k = result.findIndex((r) => r.id === previous[j].id);
      if (k >= 0) {
        at = k + 1;
        break;
      }
    }
    result.splice(at, 0, done);
  });
  return result;
}

function erplora(): ErploraClientLike {
  const c = (globalThis as { erplora?: ErploraClientLike }).erplora;
  if (!c) throw new Error('erplora SDK no inicializado por el shell');
  return c;
}

/** Id del usuario de la sesión del shell (solo para UX: vista "Mis tareas" y author_ref).
 *  La autoridad real de identidad/permisos es el runtime Rust en cada call. */
function currentUserRef(): string {
  try {
    const raw = localStorage.getItem('erplora.session');
    if (!raw) return '';
    const u = JSON.parse(raw) as { id?: string };
    return typeof u.id === 'string' ? u.id : '';
  } catch {
    return '';
  }
}

/** Locale de fechas del idioma activo. Mismo criterio que `tickets` (en → en-GB, día primero). */
function dateLocale(): string {
  return erplora().locale === 'en' ? 'en-GB' : 'es-ES';
}

/**
 * Vencimiento en el formato del hub (`01/09/2026` en es-ES), nunca en ISO (tasks#23).
 *
 * 🔴 Un vencimiento es una fecha PURA, y se formatea sin convertir de huso. La query lo devuelve
 * como datetime completo (`2026-09-01T00:00:00+00:00`) aunque el alta acepte `YYYY-MM-DD`; pasarlo
 * por `new Date(iso)` y formatearlo con el huso del navegador hace que las 00:00 UTC retrocedan un
 * día al oeste de Greenwich, y el usuario ve la tarea venciendo el día ANTES del que puso. De ahí
 * las dos guardas: se toma la parte de fecha tal cual y se formatea anclado a UTC.
 */
function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const ymd = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso));
  if (!ymd) return String(iso);
  const [, year, month, day] = ymd;
  const utc = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return new Intl.DateTimeFormat(dateLocale(), {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(utc);
}

/** Priority colour chip. Outside the class: the column getters use it, and `ok-data-table`
 *  evaluates them inside ITS shadow DOM — hence the inline tone. */
function renderPriority(priority: string) {
  return html`<ion-badge style=${ionTone('solid', priorityColor(priority))}>${priorityLabel(priority)}</ion-badge>`;
}

/** Vencimiento con su matiz: rojo si ya pasó, ámbar si es hoy, normal el resto. El formato de la
 *  fecha (`01/09/2026`) no cambia, y el aviso viaja también en texto para quien no ve el color. */
function renderDue(due: string | null | undefined, status: string) {
  const tone = dueTone(due, status);
  if (tone === 'none') return html`<span>${fmtDate(due ?? null)}</span>`;
  const color = tone === 'overdue' ? '--ion-color-danger' : '--ion-color-warning';
  const label = tone === 'overdue' ? t('ui.overdue') : t('ui.dueToday');
  return html`<span
    style=${`color: var(${color}); font-weight: 600;`}
    title=${label}
    aria-label=${label}
  >${fmtDate(due ?? null)}</span>`;
}

export class ErpTasksList extends LitElement {
  static styles = css`
    /* Cadena de altura: sin ella, el modo fill de la tabla no tiene alto que llenar. */
    :host { display:flex; flex-direction:column; height:100%; min-height:0; font-family: system-ui, sans-serif; color: var(--ion-text-color, #1c1b18); }
    .page { display:flex; flex-direction:column; min-height:0; flex:1 1 auto; }
    .pane { display:flex; flex-direction:column; min-height:0; flex:1 1 auto; }
    .pane > ok-data-table { flex:1 1 auto; min-height:0; }
    header { display:flex; gap:.5rem; align-items:center; margin-bottom:.75rem; }
    /* El alta vive en el panel lateral de la tabla: columna estrecha, no fila que se desborda. */
    .form { display:flex; flex-direction:column; gap:.7rem; }
    .form ion-button { align-self:flex-end; }
    .detail ion-input, .detail ion-select, .detail ion-textarea {
      flex:1 1 11rem; min-width:9rem;
    }
    .err { color:#d9480f; font-weight:600; }
    .detail { border:1px solid var(--ion-border-color,#e7e2d6); border-radius:12px; padding:1rem; margin:0 0 1rem;
      background:var(--ion-card-background,#fffdf7); }
    .detail-head { display:flex; gap:.6rem; align-items:center; flex-wrap:wrap; margin-bottom:.35rem; }
    .detail-head h3 { margin:0; font-size:1.05rem; flex:1; }
    .crumb { font-size:.85rem; margin-bottom:.5rem; }
    .crumb ion-button { vertical-align:middle; }
    .muted { color:var(--ion-color-medium,#6f6a5e); }
    .desc { white-space:pre-wrap; margin:.25rem 0 .75rem; }
    .meta { display:flex; gap:1.25rem; flex-wrap:wrap; font-size:.9rem; margin-bottom:.75rem; }
    .actions-row { display:flex; gap:.75rem; flex-wrap:wrap; align-items:end; margin:.5rem 0 .75rem; }
    .badge { display:inline-block; padding:.1rem .55rem; border-radius:999px; font-size:.78rem;
      font-weight:600; background:var(--ok-surface-2, var(--ion-color-step-50, rgba(var(--ion-text-color-rgb, 24, 24, 27), 0.04))); }
    .badge.done { background:#d3f9d8; color:#2b8a3e; }
    .badge.cancelled { background:#ffe3e3; color:#c92a2a; }
    .badge.in_progress { background:#d0ebff; color:#1971c2; }
    .badge.blocked { background:#fff3bf; color:#e67700; }
    h4 { margin:1rem 0 .4rem; font-size:.95rem; }
    .comment { border-top:1px solid var(--ion-border-color,#e7e2d6); padding:.45rem 0; }
    .comment .who { font-size:.8rem; color:var(--ion-color-medium,#6f6a5e); margin-bottom:.15rem; }
    .comment p { margin:0; white-space:pre-wrap; }
    .comment-form { display:flex; gap:.75rem; align-items:end; margin-top:.5rem; }
    .comment-form ion-textarea { flex:1; }
    .subtask { display:flex; gap:.6rem; align-items:center; border-top:1px solid var(--ion-border-color,#e7e2d6);
      padding:.35rem 0; }
    .subtask .t { flex:1; }
    .empty { color:var(--ion-color-medium,#6f6a5e); font-size:.9rem; padding:.35rem 0; }
    /* pm#392 — the detail buttons paint from HERE, never from \`color=\`: Ionic resolves it through a
       GLOBAL \`.ion-color-*\` rule that does not reach inside this shadow root, so the solid
       «Complete» came out with no fill and the outline «Unassign» fell back to primary blue. Custom
       properties do inherit through the boundary, so the theme token still applies. */
    ion-button.tone-success:not([fill]) {
      --background: var(--ion-color-success, #2dd55b);
      --background-activated: var(--ion-color-success-shade, #28bb50);
      --background-focused: var(--ion-color-success-shade, #28bb50);
      --background-hover: var(--ion-color-success-tint, #42d96b);
      --color: var(--ion-color-success-contrast, #000);
    }
    ion-button.tone-medium[fill] {
      --color: var(--ion-color-medium, #636469);
      --border-color: var(--ion-color-medium, #636469);
    }
  `;

  @state() view: 'all' | 'mine' = 'all';

  @state() newTitle = '';

  @state() newPriority = 'medium';

  @state() saving = false;

  /** What «Add» was refused: painted inside the panel's form, never on the page (pm#513). */
  @state() formError = '';

  /** What a row action («Start», «Complete») was refused: painted on the page, where the row is. */
  @state() pageError = '';

  // ── Vista "Mis tareas" (tasks.tasks.my) ──
  @state() myTasks: Task[] = [];

  @state() myLoading = false;

  @state() myError = '';

  /** tasks#45: tasks completed from «My tasks» during this visit to the tab, kept in their slot. */
  private keptDone = new Map<string, Task>();

  // ── Detalle (tasks.tasks.get + subtasks + comments) ──
  @state() detail: Task | null = null;

  @state() detailError = '';

  @state() detailBusy = false;

  @state() subtasks: Task[] = [];

  @state() comments: TaskComment[] = [];

  @state() assignRef = '';

  /** tasks#42: id → name of the hub's people, reloaded with every detail. */
  @state() peopleById = new Map<string, HubPerson>();

  @state() newComment = '';

  @state() newSubtaskTitle = '';

  /** Pila de drill-down padre→subtarea (ids), para el breadcrumb "volver". */
  @state() trail: Task[] = [];

  private ctrl!: ListController<Task>;

  private unsub?: () => void;

  private userRef = currentUserRef();

  // Getters (no campos): se re-evalúan en cada render, así los textos cambian con el idioma activo
  // (ADR-0055). `connectedCallback` re-renderiza al recibir `erplora:locale-changed`.
  private get columns(): DataTableColumn[] {
    return [
      { key: 'task_number', header: t('ui.colNumber'), sortable: true, filterable: true, filterType: 'text' },
      { key: 'title', header: t('ui.colTitle'), sortable: true, filterable: true, filterType: 'text' },
      {
        key: 'status',
        header: t('ui.colStatus'),
        sortable: true,
        filterable: true,
        filterType: 'select',
        options: STATUS_VALUES.map((value) => ({ value, label: statusLabel(value) })),
        format: (r) => statusLabel(r.status as string),
      },
      {
        key: 'priority',
        header: t('ui.colPriority'),
        sortable: true,
        filterable: true,
        filterType: 'select',
        options: PRIORITY_VALUES.map((value) => ({ value, label: priorityLabel(value) })),
        // Sin `format` la celda cae al valor crudo de la fila: el filtro salía traducido y la
        // columna, en inglés (tasks#23). Se conserva como texto (búsqueda, exportación) aunque
        // `render` tenga prioridad sobre él.
        format: (r) => priorityLabel(r.priority as string),
        render: (r) => renderPriority(r.priority as string),
      },
      {
        key: 'due_date',
        header: t('ui.colDueDate'),
        sortable: true,
        filterable: true,
        filterType: 'daterange',
        format: (r) => fmtDate(r.due_date as string | null),
        render: (r) => renderDue(r.due_date as string | null, r.status as string),
      },
    ];
  }

  private get rowActions() {
    // tasks#45: a card offers only what can still be done to it — the one kept as done in «My tasks»
    // must not invite a second «Complete». `hidden` drops the button (OutfitKit ≥ 0.1.84); `disabled`
    // covers an older shell that ignores it.
    const closed = (r: Record<string, unknown>) => r.status === 'done' || r.status === 'cancelled';
    const notStartable = (r: Record<string, unknown>) => r.status === 'in_progress' || closed(r);
    return [
      { id: 'detail', label: t('ui.actionDetail'), icon: 'open-outline', color: 'primary' },
      { id: 'start', label: t('ui.actionStart'), icon: 'play-circle-outline', color: 'primary', hidden: notStartable, disabled: notStartable },
      { id: 'complete', label: t('ui.actionComplete'), icon: 'checkmark-done-outline', color: 'success', hidden: closed, disabled: closed },
    ];
  }

  // Re-render al cambiar el idioma del shell (ADR-0055): los getters `columns`/`rowActions` y el
  // texto del template se re-evalúan con el nuevo `erplora.locale`.
  private readonly onLocaleChange = (): void => this.requestUpdate();

  async connectedCallback() {
    super.connectedCallback();
    window.addEventListener('erplora:locale-changed', this.onLocaleChange);
    this.ctrl = createListController<Task>(erplora(), 'tasks.tasks.list', () => this.requestUpdate(), {
      pageSize: 50,
      sort: 'created_at',
      dir: 'desc',
    });
    await this.ctrl.load();
    try {
            // Una suscripción por evento, con su literal EN la llamada (ADR-0127: el extractor
      // de contratos no sigue arrays; el nombre vive donde se usa).
      const offs = [
        erplora().on('tasks.task.created', () => this.onDomainEvent()),
        erplora().on('tasks.task.status_changed', () => this.onDomainEvent()),
        erplora().on('tasks.task.completed', () => this.onDomainEvent()),
        erplora().on('tasks.task.assigned', () => this.onDomainEvent()),
        erplora().on('tasks.comment.added', () => this.onDomainEvent()),
      ];
      this.unsub = () => offs.forEach((off) => off());
    } catch {
      /* sin SDK (preview) → sin reactividad en vivo */
    }
  }

  disconnectedCallback() {
    window.removeEventListener('erplora:locale-changed', this.onLocaleChange);
    super.disconnectedCallback();
    this.unsub?.();
  }

  /** Refresco por evento de dominio: lista activa + detalle abierto. */
  private onDomainEvent() {
    void this.ctrl.load();
    if (this.view === 'mine') void this.loadMyTasks();
    if (this.detail) void this.loadDetail(this.detail.id, { keepTrail: true });
  }

  private async loadMyTasks() {
    if (!this.userRef) return;
    this.myLoading = true;
    this.myError = '';
    try {
      const rows = await erplora().query<Task[]>('tasks.tasks.my', {
        assigned_to_ref: this.userRef,
        apply_horizon: 0,
        due_horizon: null,
      });
      this.myTasks = keepCompletedInPlace(this.myTasks, rows ?? [], this.keptDone);
    } catch (e) {
      this.myError = e instanceof Error ? e.message : t('ui.errLoadMine');
    } finally {
      this.myLoading = false;
    }
  }

  private setView(view: 'all' | 'mine') {
    this.view = view;
    // Leaving the tab (or coming back to it) is when the completed ones are let go.
    this.keptDone = new Map();
    if (view === 'mine') void this.loadMyTasks();
  }

  // ── Detalle + drill-down ──────────────────────────────────────────────────

  private async loadDetail(taskId: string, opts: { keepTrail?: boolean } = {}) {
    this.detailError = '';
    try {
      const rows = await erplora().query<Task[]>('tasks.tasks.get', { task_id: taskId });
      const task = rows?.[0];
      if (!task) {
        // La tarea ya no existe (p.ej. borrada): cierra el detalle.
        if (!opts.keepTrail) this.closeDetail();
        return;
      }
      this.detail = task;
      this.assignRef = task.assigned_to_ref ?? '';
      const [subs, comments, people] = await Promise.all([
        erplora().query<Task[]>('tasks.tasks.subtasks', { task_id: taskId }),
        erplora().query<TaskComment[]>('tasks.tasks.comments', { task_id: taskId }),
        // tasks#42: optional on purpose. Without it (no session permission, the core down) the
        // detail still opens and names nobody — a readable «unknown» beats a raw id.
        erplora().query<HubPerson[]>('hub.users.list').catch(() => []),
      ]);
      this.peopleById = new Map(
        (Array.isArray(people) ? people : [])
          .filter((p) => p && p.id && String(p.name ?? '').trim())
          .map((p) => [String(p.id), { ...p, name: String(p.name).trim() }]),
      );
      this.subtasks = subs ?? [];
      this.comments = comments ?? [];
    } catch (e) {
      this.detailError = e instanceof Error ? e.message : t('ui.errLoadDetail');
    }
  }

  /** tasks#42 · the name behind a person id. An id the hub no longer lists (or a list that could
   *  not be loaded) reads as «unknown person»: the raw id is never painted. */
  private personName(ref: string): string {
    return this.peopleById.get(ref)?.name || t('ui.unknownPerson');
  }

  /** Who can be picked as the new assignee: the hub's active people, by name. */
  private get assignablePeople(): HubPerson[] {
    return [...this.peopleById.values()]
      .filter((p) => p.is_active !== false)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  private openDetail(task: Task) {
    this.trail = [];
    void this.loadDetail(task.id);
  }

  /** Drill-down a una subtarea (apila el padre actual en el breadcrumb). */
  private drillDown(sub: Task) {
    if (this.detail) this.trail = [...this.trail, this.detail];
    void this.loadDetail(sub.id);
  }

  private goBack() {
    const parent = this.trail[this.trail.length - 1];
    if (!parent) return;
    this.trail = this.trail.slice(0, -1);
    void this.loadDetail(parent.id);
  }

  private closeDetail() {
    this.detail = null;
    this.trail = [];
    this.subtasks = [];
    this.comments = [];
    this.detailError = '';
  }

  // ── Commands ──────────────────────────────────────────────────────────────

  // El helper recibe el THUNK, no el nombre (ADR-0127: el literal del contrato vive EN la llamada).
  // `onAccepted` runs as soon as the hub says yes, before the refresh (tasks#44): a box that keeps
  // what was just sent while the screen reloads reads as «it did not go through».
  private async runCommand(exec: () => Promise<unknown>, onAccepted?: () => void) {
    this.detailBusy = true;
    this.detailError = '';
    try {
      await exec();
      onAccepted?.();
      await this.ctrl.load();
      if (this.view === 'mine') await this.loadMyTasks();
      if (this.detail) await this.loadDetail(this.detail.id, { keepTrail: true });
    } catch (e) {
      this.detailError = e instanceof Error ? e.message : t('ui.errRunAction');
    } finally {
      this.detailBusy = false;
    }
  }

  /** A row action runs with no detail open: its refusal goes to the page, never to the detail error,
   *  which is not painted then (pm#513). */
  private async runRowAction(exec: () => Promise<unknown>, done?: { message: string; keep?: Task }) {
    this.pageError = '';
    try {
      await exec();
      if (done?.keep && this.view === 'mine') this.keptDone.set(done.keep.id, done.keep);
      // tasks#45: the card alone does not say the action worked (in «My tasks» it used to vanish).
      if (done) erplora().notify?.({ type: 'success', message: done.message });
      await this.ctrl.load();
      if (this.view === 'mine') await this.loadMyTasks();
    } catch (e) {
      this.pageError = e instanceof Error ? e.message : t('ui.errRunAction');
    }
  }

  /** Referencia al panel lateral de la tabla: guardar lo cierra. */
  private dataTable(): { open(p?: 'filters' | 'create'): void; close(): void } | null {
    return this.renderRoot.querySelector('ok-data-table') as
      | { open(p?: 'filters' | 'create'): void; close(): void }
      | null;
  }

  private async createTask(ev: Event) {
    ev.preventDefault();
    if (!this.newTitle.trim()) return;
    this.saving = true;
    this.formError = '';
    this.pageError = ''; // a save is the next thing the person did: an older row refusal is stale
    try {
      await erplora().command('tasks.tasks.create', {
        title: this.newTitle.trim(),
        description: '',
        project_id: null,
        assigned_to_ref: null,
        due_date: null,
        priority: this.newPriority,
        parent_task_id: null,
        created_by_ref: null,
        tags: [],
      });
      this.newTitle = '';
      this.newPriority = 'medium';
      this.dataTable()?.close();
      await this.ctrl.load();
    } catch (e) {
      this.formError = e instanceof Error ? e.message : t('ui.errCreateTask');
    } finally {
      this.saving = false;
    }
  }

  private async onRowAction(ev: CustomEvent<{ actionId: string; row: Record<string, unknown> }>) {
    const { actionId, row } = ev.detail;
    const task = row as unknown as Task;
    switch (actionId) {
      case 'detail':
        this.openDetail(task);
        break;
      case 'start':
        await this.runRowAction(
          () => erplora().command('tasks.tasks.update_status', { task_id: task.id, new_status: 'in_progress' }),
          { message: t('ui.taskStarted') },
        );
        break;
      case 'complete':
        await this.runRowAction(() => erplora().command('tasks.tasks.complete', { task_id: task.id }), {
          message: t('ui.taskCompleted'),
          keep: { ...task, status: 'done' },
        });
        break;
    }
  }

  private async changeStatus(newStatus: string) {
    if (!this.detail || !newStatus || newStatus === this.detail.status) return;
    await this.runCommand(() => erplora().command('tasks.tasks.update_status', { task_id: this.detail.id, new_status: newStatus }));
  }

  private async completeTask() {
    if (!this.detail) return;
    await this.runCommand(() => erplora().command('tasks.tasks.complete', { task_id: this.detail.id }));
  }

  private async assignTask(ref: string | null) {
    if (!this.detail) return;
    await this.runCommand(() => erplora().command('tasks.tasks.assign', {
      task_id: this.detail.id,
      assigned_to_ref: ref && ref.trim() ? ref.trim() : null,
    }));
  }

  private async addComment(ev: Event) {
    ev.preventDefault();
    const sent = this.newComment;
    if (!this.detail || !sent.trim()) return;
    await this.runCommand(
      () => erplora().command('tasks.tasks.add_comment', {
        task_id: this.detail.id,
        comment: sent.trim(),
        author_ref: this.userRef || null,
      }),
      // What the person typed while it was on its way is theirs: only the sent text is cleared.
      () => {
        if (this.newComment === sent) this.newComment = '';
      },
    );
  }

  private async addSubtask(ev: Event) {
    ev.preventDefault();
    const sent = this.newSubtaskTitle;
    if (!this.detail || !sent.trim()) return;
    await this.runCommand(
      () => erplora().command('tasks.tasks.create', {
        title: sent.trim(),
        description: '',
        project_id: this.detail.project_id,
        assigned_to_ref: null,
        due_date: null,
        priority: 'medium',
        parent_task_id: this.detail.id,
        created_by_ref: null,
        tags: [],
      }),
      () => {
        if (this.newSubtaskTitle === sent) this.newSubtaskTitle = '';
      },
    );
  }

  // ── Render ────────────────────────────────────────────────────────────────

  private renderBadge(status: string) {
    return html`<span class="badge ${status}">${statusLabel(status)}</span>`;
  }

  private renderDetail() {
    const task = this.detail;
    if (!task) return nothing;
    const closed = task.status === 'done' || task.status === 'cancelled';
    return html`<section class="detail">
      ${this.trail.length
        ? html`<div class="crumb">
            <ion-button size="small" fill="clear" @click=${() => this.goBack()}>← ${t('ui.back')}</ion-button>
            <span class="muted">${this.trail.map((p) => p.task_number).join(' › ')} › ${task.task_number}</span>
          </div>`
        : nothing}
      <div class="detail-head">
        <h3>${task.task_number} — ${task.title}</h3>
        ${this.renderBadge(task.status)}
        ${renderPriority(task.priority)}
        <ion-button size="small" fill="clear" @click=${() => this.closeDetail()}>${t('ui.close')}</ion-button>
      </div>
      ${task.description ? html`<p class="desc">${task.description}</p>` : nothing}
      <div class="meta">
        <span><strong>${t('ui.dueLabel')}</strong> ${renderDue(task.due_date, task.status)}</span>
        <span><strong>${t('ui.completedLabel')}</strong> ${fmtDate(task.completed_at)}</span>
        <span><strong>${t('ui.assignedToLabel')}</strong> ${task.assigned_to_ref ? this.personName(task.assigned_to_ref) : t('ui.unassigned')}</span>
        <span><strong>${t('ui.createdLabel')}</strong> ${fmtDate(task.created_at)}</span>
      </div>

      <div class="actions-row">
        <ion-select mode="md" fill="outline" label=${t('ui.colStatus')} label-placement="floating" .value=${task.status}
          ?disabled=${this.detailBusy}
          @ionChange=${(e: any) => this.changeStatus(e.target.value)}>
          ${STATUS_VALUES.map(
            (k) => html`<ion-select-option .value=${k}>${statusLabel(k)}</ion-select-option>`,
          )}
        </ion-select>
        <ion-button size="small" class="tone-success" ?disabled=${this.detailBusy || closed}
          @click=${() => this.completeTask()}>${t('ui.actionComplete')}</ion-button>
        <ion-select data-testid="tasks-list-assign-ref" mode="md" fill="outline" label-placement="floating" label=${t('ui.assignToLabel')}
          placeholder=${this.assignablePeople.length ? t('ui.pickPersonPlaceholder') : t('ui.noPeople')} .value=${this.assignRef}
          ?disabled=${this.detailBusy || !this.assignablePeople.length}
          @ionChange=${(e: any) => (this.assignRef = e.detail?.value ?? e.target.value ?? '')}>
          ${this.assignablePeople.map((p) => html`<ion-select-option .value=${p.id}>${p.name}</ion-select-option>`)}
        </ion-select>
        <ion-button data-testid="tasks-list-assign-submit" size="small" ?disabled=${this.detailBusy || !this.assignRef.trim()}
          @click=${() => this.assignTask(this.assignRef)}>${t('ui.actionAssign')}</ion-button>
        ${this.userRef && this.userRef !== task.assigned_to_ref
          ? html`<ion-button size="small" fill="outline" ?disabled=${this.detailBusy}
              @click=${() => this.assignTask(this.userRef)}>${t('ui.actionAssignToMe')}</ion-button>`
          : nothing}
        ${task.assigned_to_ref
          ? html`<ion-button size="small" fill="outline" class="tone-medium" ?disabled=${this.detailBusy}
              @click=${() => this.assignTask(null)}>${t('ui.actionUnassign')}</ion-button>`
          : nothing}
      </div>
      ${this.detailError ? html`<p class="err">${this.detailError}</p>` : nothing}

      <h4>${t('ui.subtasksHeading', { count: this.subtasks.length })}</h4>
      ${this.subtasks.length
        ? this.subtasks.map(
            (s) => html`<div class="subtask">
              <span class="t">${s.task_number} — ${s.title}</span>
              ${this.renderBadge(s.status)}
              <ion-button size="small" fill="clear" @click=${() => this.drillDown(s)}>${t('ui.actionOpen')}</ion-button>
            </div>`,
          )
        : html`<p class="empty">${t('ui.emptySubtasks')}</p>`}
      <form class="comment-form" @submit=${(e: Event) => this.addSubtask(e)}>
        <ion-input mode="md" fill="outline" label-placement="floating" label=${t('ui.actionAddSubtask')} placeholder=${t('ui.newSubtaskPlaceholder')} .value=${this.newSubtaskTitle}
          @ionInput=${(e: any) => (this.newSubtaskTitle = e.target.value)}></ion-input>
        <ion-button type="submit" size="small" ?disabled=${this.detailBusy || !this.newSubtaskTitle}>
          ${t('ui.actionAddSubtask')}</ion-button>
      </form>

      <h4>${t('ui.commentsHeading', { count: this.comments.length })}</h4>
      ${this.comments.length
        ? this.comments.map(
            (c) => html`<div class="comment">
              <div class="who"><span class="author">${c.author_ref ? this.personName(c.author_ref) : t('ui.anonymous')}</span> · ${String(c.created_at).slice(0, 16).replace('T', ' ')}</div>
              <p>${c.comment}</p>
            </div>`,
          )
        : html`<p class="empty">${t('ui.emptyComments')}</p>`}
      <form class="comment-form" @submit=${(e: Event) => this.addComment(e)}>
        <ion-textarea mode="md" fill="outline" label-placement="floating" label=${t('ui.actionComment')} auto-grow rows="1" placeholder=${t('ui.addCommentPlaceholder')} .value=${this.newComment}
          @ionInput=${(e: any) => (this.newComment = e.target.value)}></ion-textarea>
        <ion-button type="submit" size="small" ?disabled=${this.detailBusy || !this.newComment.trim()}>
          ${t('ui.actionComment')}</ion-button>
      </form>
    </section>`;
  }

  private renderAll() {
    return html`<div class="pane">
      ${this.ctrl?.error ? html`<p class="err">${this.ctrl.error}</p>` : nothing}
      <ok-data-table .serverSide=${true} .fill=${true} .addable=${true} .views=${true} .cardTitle=${(row: Record<string, unknown>) => String(row.title ?? row.task_number ?? '—')} .columns=${this.columns} .rows=${this.ctrl?.rows ?? []} .total=${this.ctrl?.total ?? 0} .page=${this.ctrl?.state.page ?? 0} .pageSize=${this.ctrl?.state.pageSize ?? 50} .sort=${this.ctrl?.state.sort} .sortDir=${this.ctrl?.state.dir ?? 'desc'} .searchable=${true} .searchPlaceholder=${t('ui.searchTasksPlaceholder')} .actions=${this.rowActions} .rowClickable=${true} .emptyMessage=${this.ctrl?.loading ? t('ui.loading') : t('ui.emptyTasks')} @rowAction=${(e: CustomEvent) => this.onRowAction(e)} @rowClick=${(e: CustomEvent<{ row: Record<string, unknown> }>) => this.onRowAction({ detail: { actionId: 'detail', row: e.detail.row } } as CustomEvent<{ actionId: string; row: Record<string, unknown> }>)} @pageChange=${(e: CustomEvent<number>) => this.ctrl.setPage(e.detail)} @sortChange=${(e: CustomEvent<{ sort: string; dir: 'asc' | 'desc' }>) => this.ctrl.setSort(e.detail.sort, e.detail.dir)} @searchChange=${(e: CustomEvent<string>) => this.ctrl.setSearch(e.detail)} @filterChange=${(e: CustomEvent<{ col: string; value: unknown }>) => this.ctrl.setFilter(e.detail.col, e.detail.value)}>
        <!-- El formulario se proyecta SIEMPRE en el panel: si solo se pintara al abrirlo, el «+»
             abriría un panel vacío (la tabla no re-renderiza a sus hijos de luz). -->
        <form slot="create" class="form" @submit=${(e: Event) => this.createTask(e)}>
          <ion-input mode="md" fill="outline" label-placement="floating" label=${t('ui.colTitle')} placeholder=${t('ui.newTaskPlaceholder')} .value=${this.newTitle} @ionInput=${(e: any) => (this.newTitle = e.target.value)}></ion-input>
          <ion-select mode="md" fill="outline" label-placement="floating" label=${t('ui.colPriority')} placeholder=${t('ui.priorityPlaceholder')} .value=${this.newPriority} @ionChange=${(e: any) => (this.newPriority = e.target.value)}>
            ${PRIORITY_VALUES.map(
              (k) => html`<ion-select-option .value=${k}>${priorityLabel(k)}</ion-select-option>`,
            )}
          </ion-select>
          <!-- pm#513: the refusal travels WITH the form — under 834 px the panel is a full-screen
               sheet and a line on the page underneath it is never seen. -->
          ${this.formError ? html`<p class="err" data-testid="tasks-list-form-error">${this.formError}</p>` : nothing}
          <ion-button type="submit" size="small" ?disabled=${this.saving || !this.newTitle}>${this.saving ? t('ui.saving') : t('ui.add')}</ion-button>
        </form>
      </ok-data-table>
    </div>`;
  }

  private renderMine() {
    if (!this.userRef) {
      return html`<p class="empty">${t('ui.noSessionMine')}</p>`;
    }
    return html`<div class="pane">
      ${this.myError ? html`<p class="err">${this.myError}</p>` : nothing}
      <ok-data-table .fill=${true} .views=${true} .cardTitle=${(row: Record<string, unknown>) => String(row.title ?? row.task_number ?? '—')} .columns=${this.columns} .rows=${this.myTasks as unknown as Record<string, unknown>[]} .searchKeys=${['task_number', 'title']} .searchPlaceholder=${t('ui.searchTasksPlaceholder')} .actions=${this.rowActions} .rowClickable=${true} .emptyMessage=${this.myLoading ? t('ui.loading') : t('ui.emptyMine')} @rowAction=${(e: CustomEvent) => this.onRowAction(e)} @rowClick=${(e: CustomEvent<{ row: Record<string, unknown> }>) => this.onRowAction({ detail: { actionId: 'detail', row: e.detail.row } } as CustomEvent<{ actionId: string; row: Record<string, unknown> }>)}></ok-data-table>
    </div>`;
  }

  /** pm#513: the refusal appears above the button that was pressed — on a phone that can leave it
   *  off the sheet. Bring it into view when it appears, not again on every keystroke. */
  updated(changed: PropertyValues): void {
    super.updated(changed);
    if (changed.has('formError') && this.formError) {
      this.renderRoot.querySelector('[data-testid="tasks-list-form-error"]')?.scrollIntoView?.({ block: 'center' });
    }
  }

  render() {
    return html`<div class="page">
        <header>
          <ion-segment .value=${this.view} @ionChange=${(e: any) => this.setView(e.detail.value)}>
            <ion-segment-button value="all"><ion-label>${t('ui.tabAll')}</ion-label></ion-segment-button>
            ${this.userRef
              ? html`<ion-segment-button value="mine"><ion-label>${t('ui.tabMine')}</ion-label></ion-segment-button>`
              : nothing}
          </ion-segment>
        </header>
        ${this.pageError ? html`<p class="err" data-testid="tasks-list-error">${this.pageError}</p>` : nothing}
        ${this.renderDetail()}
        ${this.view === 'all' ? this.renderAll() : this.renderMine()}
      </div>`;
  }
}

define('erp-tasks-list', ErpTasksList);
