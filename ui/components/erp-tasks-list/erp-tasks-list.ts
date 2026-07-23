import { LitElement, html, css, nothing } from 'lit';
import { state } from 'lit/decorators.js';
import { define } from '@erplora/outfitkit/define';
import '@erplora/outfitkit/ok-inline-feedback';
import '@erplora/outfitkit/ok-data-table';
import '@erplora/outfitkit/ok-empty-state';
import type { DataTableColumn } from '@erplora/outfitkit';
import { createListController } from '@erplora/module-sdk';
import type { ListController, ListClient, ListParams, ListPage } from '@erplora/module-sdk';
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

function fmtDate(iso: string | null | undefined): string {
  return iso ? String(iso).slice(0, 10) : '—';
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
    .detail { border:1px solid var(--ion-border-color,#e7e2d6); border-radius: var(--ok-radius, 12px); padding:1rem; margin:0 0 1rem;
      background:var(--ion-card-background,#fffdf7); }
    .detail-head { display:flex; gap:.6rem; align-items:center; flex-wrap:wrap; margin-bottom:.35rem; }
    .detail-head h3 { margin:0; font-size:1.05rem; flex:1; }
    .crumb { font-size:.85rem; margin-bottom:.5rem; }
    .crumb ion-button { vertical-align:middle; }
    .muted { color:var(--ion-color-medium,#6f6a5e); }
    .desc { white-space:pre-wrap; margin:.25rem 0 .75rem; }
    .meta { display:flex; gap:1.25rem; flex-wrap:wrap; font-size:.9rem; margin-bottom:.75rem; }
    .actions-row { display:flex; gap:.75rem; flex-wrap:wrap; align-items:end; margin:.5rem 0 .75rem; }
    .badge { display:inline-block; padding:.1rem .55rem; border-radius: var(--ok-radius-pill, 999px); font-size:.78rem;
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
  `;

  @state() view: 'all' | 'mine' = 'all';

  @state() newTitle = '';

  @state() newPriority = 'medium';

  @state() saving = false;

  @state() formError = '';

  // ── Vista "Mis tareas" (tasks.tasks.my) ──
  @state() myTasks: Task[] = [];

  @state() myLoading = false;

  @state() myError = '';

  // ── Detalle (tasks.tasks.get + subtasks + comments) ──
  @state() detail: Task | null = null;

  @state() detailError = '';

  @state() detailBusy = false;

  @state() subtasks: Task[] = [];

  @state() comments: TaskComment[] = [];

  @state() assignRef = '';

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
      },
      {
        key: 'due_date',
        header: t('ui.colDueDate'),
        sortable: true,
        filterable: true,
        filterType: 'daterange',
        format: (r) => fmtDate(r.due_date as string | null),
      },
    ];
  }

  private get rowActions() {
    return [
      { id: 'detail', label: t('ui.actionDetail'), icon: 'open-outline', color: 'primary' },
      { id: 'start', label: t('ui.actionStart'), icon: 'play-circle-outline', color: 'primary' },
      { id: 'complete', label: t('ui.actionComplete'), icon: 'checkmark-done-outline', color: 'success' },
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
      this.myTasks = rows ?? [];
    } catch (e) {
      this.myError = e instanceof Error ? e.message : t('ui.errLoadMine');
    } finally {
      this.myLoading = false;
    }
  }

  private setView(view: 'all' | 'mine') {
    this.view = view;
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
      const [subs, comments] = await Promise.all([
        erplora().query<Task[]>('tasks.tasks.subtasks', { task_id: taskId }),
        erplora().query<TaskComment[]>('tasks.tasks.comments', { task_id: taskId }),
      ]);
      this.subtasks = subs ?? [];
      this.comments = comments ?? [];
    } catch (e) {
      this.detailError = e instanceof Error ? e.message : t('ui.errLoadDetail');
    }
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
  private async runCommand(exec: () => Promise<unknown>, refreshDetail = true) {
    this.detailBusy = true;
    this.detailError = '';
    try {
      await exec();
      await this.ctrl.load();
      if (this.view === 'mine') await this.loadMyTasks();
      if (refreshDetail && this.detail) await this.loadDetail(this.detail.id, { keepTrail: true });
    } catch (e) {
      this.detailError = e instanceof Error ? e.message : t('ui.errRunAction');
    } finally {
      this.detailBusy = false;
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
        await this.runCommand(() => erplora().command('tasks.tasks.update_status', { task_id: task.id, new_status: 'in_progress' }), false);
        break;
      case 'complete':
        await this.runCommand(() => erplora().command('tasks.tasks.complete', { task_id: task.id }), false);
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
    if (!this.detail || !this.newComment.trim()) return;
    await this.runCommand(() => erplora().command('tasks.tasks.add_comment', {
      task_id: this.detail.id,
      comment: this.newComment.trim(),
      author_ref: this.userRef || null,
    }));
    if (!this.detailError) this.newComment = '';
  }

  private async addSubtask(ev: Event) {
    ev.preventDefault();
    if (!this.detail || !this.newSubtaskTitle.trim()) return;
    await this.runCommand(() => erplora().command('tasks.tasks.create', {
      title: this.newSubtaskTitle.trim(),
      description: '',
      project_id: this.detail.project_id,
      assigned_to_ref: null,
      due_date: null,
      priority: 'medium',
      parent_task_id: this.detail.id,
      created_by_ref: null,
      tags: [],
    }));
    if (!this.detailError) this.newSubtaskTitle = '';
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
        <span class="badge">${priorityLabel(task.priority)}</span>
        <ion-button size="small" fill="clear" @click=${() => this.closeDetail()}>${t('ui.close')}</ion-button>
      </div>
      ${task.description ? html`<p class="desc">${task.description}</p>` : nothing}
      <div class="meta">
        <span><strong>${t('ui.dueLabel')}</strong> ${fmtDate(task.due_date)}</span>
        <span><strong>${t('ui.completedLabel')}</strong> ${fmtDate(task.completed_at)}</span>
        <span><strong>${t('ui.assignedToLabel')}</strong> ${task.assigned_to_ref ?? '—'}</span>
        <span><strong>${t('ui.createdLabel')}</strong> ${fmtDate(task.created_at)}</span>
      </div>

      <div class="actions-row">
        <ion-select fill="outline" label=${t('ui.colStatus')} label-placement="floating" .value=${task.status}
          ?disabled=${this.detailBusy}
          @ionChange=${(e: any) => this.changeStatus(e.target.value)}>
          ${STATUS_VALUES.map(
            (k) => html`<ion-select-option .value=${k}>${statusLabel(k)}</ion-select-option>`,
          )}
        </ion-select>
        <ion-button size="small" color="success" ?disabled=${this.detailBusy || closed}
          @click=${() => this.completeTask()}>${t('ui.actionComplete')}</ion-button>
        <ion-input fill="outline" label-placement="floating" label=${t('ui.assignToLabel')} placeholder=${t('ui.userUuidPlaceholder')} .value=${this.assignRef}
          @ionInput=${(e: any) => (this.assignRef = e.target.value)}></ion-input>
        <ion-button size="small" ?disabled=${this.detailBusy}
          @click=${() => this.assignTask(this.assignRef)}>${t('ui.actionAssign')}</ion-button>
        ${this.userRef && this.userRef !== task.assigned_to_ref
          ? html`<ion-button size="small" fill="outline" ?disabled=${this.detailBusy}
              @click=${() => this.assignTask(this.userRef)}>${t('ui.actionAssignToMe')}</ion-button>`
          : nothing}
        ${task.assigned_to_ref
          ? html`<ion-button size="small" fill="outline" color="medium" ?disabled=${this.detailBusy}
              @click=${() => this.assignTask(null)}>${t('ui.actionUnassign')}</ion-button>`
          : nothing}
      </div>
      ${this.detailError ? html`<ok-inline-feedback tone="danger" icon="alert-circle-outline">${this.detailError}</ok-inline-feedback>` : nothing}

      <h4>${t('ui.subtasksHeading', { count: this.subtasks.length })}</h4>
      ${this.subtasks.length
        ? this.subtasks.map(
            (s) => html`<div class="subtask">
              <span class="t">${s.task_number} — ${s.title}</span>
              ${this.renderBadge(s.status)}
              <ion-button size="small" fill="clear" @click=${() => this.drillDown(s)}>${t('ui.actionOpen')}</ion-button>
            </div>`,
          )
        : html`<ok-empty-state icon="list-outline" message=${t('ui.emptySubtasks')}></ok-empty-state>`}
      <form class="comment-form" @submit=${(e: Event) => this.addSubtask(e)}>
        <ion-input fill="outline" label-placement="floating" label=${t('ui.actionAddSubtask')} placeholder=${t('ui.newSubtaskPlaceholder')} .value=${this.newSubtaskTitle}
          @ionInput=${(e: any) => (this.newSubtaskTitle = e.target.value)}></ion-input>
        <ion-button type="submit" size="small" ?disabled=${this.detailBusy || !this.newSubtaskTitle}>
          ${t('ui.actionAddSubtask')}</ion-button>
      </form>

      <h4>${t('ui.commentsHeading', { count: this.comments.length })}</h4>
      ${this.comments.length
        ? this.comments.map(
            (c) => html`<div class="comment">
              <div class="who">${c.author_ref ?? t('ui.anonymous')} · ${String(c.created_at).slice(0, 16).replace('T', ' ')}</div>
              <p>${c.comment}</p>
            </div>`,
          )
        : html`<ok-empty-state icon="chatbubble-ellipses-outline" message=${t('ui.emptyComments')}></ok-empty-state>`}
      <form class="comment-form" @submit=${(e: Event) => this.addComment(e)}>
        <ion-textarea fill="outline" label-placement="floating" label=${t('ui.actionComment')} auto-grow rows="1" placeholder=${t('ui.addCommentPlaceholder')} .value=${this.newComment}
          @ionInput=${(e: any) => (this.newComment = e.target.value)}></ion-textarea>
        <ion-button type="submit" size="small" ?disabled=${this.detailBusy || !this.newComment.trim()}>
          ${t('ui.actionComment')}</ion-button>
      </form>
    </section>`;
  }

  private renderAll() {
    return html`<div class="pane">
      ${this.formError ? html`<ok-inline-feedback tone="danger" icon="alert-circle-outline">${this.formError}</ok-inline-feedback>` : nothing}
      ${this.ctrl?.error ? html`<ok-inline-feedback tone="danger" icon="alert-circle-outline">${this.ctrl.error}</ok-inline-feedback>` : nothing}
      <ok-data-table .serverSide=${true} .fill=${true} .addable=${true} .columns=${this.columns} .views=${true} .cardTitle=${(r: Record<string, unknown>) => String(r.title ?? '—')} .cardIcon=${() => 'checkbox-outline'} .rows=${this.ctrl?.rows ?? []} .total=${this.ctrl?.total ?? 0} .page=${this.ctrl?.state.page ?? 0} .pageSize=${this.ctrl?.state.pageSize ?? 50} .sort=${this.ctrl?.state.sort} .sortDir=${this.ctrl?.state.dir ?? 'desc'} .searchable=${true} .searchPlaceholder=${t('ui.searchTasksPlaceholder')} .actions=${this.rowActions} .emptyMessage=${this.ctrl?.loading ? t('ui.loading') : t('ui.emptyTasks')} @rowAction=${(e: CustomEvent) => this.onRowAction(e)} @pageChange=${(e: CustomEvent<number>) => this.ctrl.setPage(e.detail)} @sortChange=${(e: CustomEvent<{ sort: string; dir: 'asc' | 'desc' }>) => this.ctrl.setSort(e.detail.sort, e.detail.dir)} @searchChange=${(e: CustomEvent<string>) => this.ctrl.setSearch(e.detail)} @filterChange=${(e: CustomEvent<{ col: string; value: unknown }>) => this.ctrl.setFilter(e.detail.col, e.detail.value)}>
        <!-- El formulario se proyecta SIEMPRE en el panel: si solo se pintara al abrirlo, el «+»
             abriría un panel vacío (la tabla no re-renderiza a sus hijos de luz). -->
        <form slot="create" class="form" @submit=${(e: Event) => this.createTask(e)}>
          <ion-input fill="outline" label-placement="floating" label=${t('ui.colTitle')} placeholder=${t('ui.newTaskPlaceholder')} .value=${this.newTitle} @ionInput=${(e: any) => (this.newTitle = e.target.value)}></ion-input>
          <ion-select fill="outline" label-placement="floating" label=${t('ui.colPriority')} placeholder=${t('ui.priorityPlaceholder')} .value=${this.newPriority} @ionChange=${(e: any) => (this.newPriority = e.target.value)}>
            ${PRIORITY_VALUES.map(
              (k) => html`<ion-select-option .value=${k}>${priorityLabel(k)}</ion-select-option>`,
            )}
          </ion-select>
          <ion-button type="submit" size="small" ?disabled=${this.saving || !this.newTitle}>${this.saving ? t('ui.saving') : t('ui.add')}</ion-button>
        </form>
      </ok-data-table>
    </div>`;
  }

  private renderMine() {
    if (!this.userRef) {
      return html`<ok-empty-state icon="person-outline" message=${t('ui.noSessionMine')}></ok-empty-state>`;
    }
    return html`<div class="pane">
      ${this.myError ? html`<ok-inline-feedback tone="danger" icon="alert-circle-outline">${this.myError}</ok-inline-feedback>` : nothing}
      <ok-data-table .fill=${true} .columns=${this.columns} .views=${true} .cardTitle=${(r: Record<string, unknown>) => String(r.title ?? '—')} .cardIcon=${() => 'checkbox-outline'} .rows=${this.myTasks as unknown as Record<string, unknown>[]} .searchKeys=${['task_number', 'title']} .searchPlaceholder=${t('ui.searchTasksPlaceholder')} .actions=${this.rowActions} .emptyMessage=${this.myLoading ? t('ui.loading') : t('ui.emptyMine')} @rowAction=${(e: CustomEvent) => this.onRowAction(e)}></ok-data-table>
    </div>`;
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
        ${this.renderDetail()}
        ${this.view === 'all' ? this.renderAll() : this.renderMine()}
      </div>`;
  }
}

define('erp-tasks-list', ErpTasksList);
