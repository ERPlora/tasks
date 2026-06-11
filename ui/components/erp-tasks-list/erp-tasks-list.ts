import { LitElement, html, css, nothing } from 'lit';
import { state } from 'lit/decorators.js';
import { define } from '@erplora/outfitkit/define';
import '@erplora/outfitkit/ok-data-table';
import type { DataTableColumn } from '@erplora/outfitkit';
import { createListController } from '@erplora/module-sdk';
import type { ListController, ListClient, ListParams, ListPage } from '@erplora/module-sdk';

interface ErploraClientLike extends ListClient {
  query<T = unknown>(name: string, params?: Record<string, unknown>): Promise<T>;
  queryPage<R = unknown>(name: string, params: ListParams): Promise<ListPage<R>>;
  command<T = unknown>(name: string, payload?: Record<string, unknown>): Promise<T>;
  on(event: string, cb: (payload: unknown) => void): () => void;
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

const STATUS_LABELS: Record<string, string> = {
  todo: 'To Do',
  in_progress: 'In Progress',
  blocked: 'Blocked',
  done: 'Done',
  cancelled: 'Cancelled',
};

const PRIORITY_LABELS: Record<string, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  urgent: 'Urgent',
};

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
    :host { display:block; font-family: system-ui, sans-serif; color: var(--ink, #1c1b18); }
    header { display:flex; gap:.5rem; align-items:center; margin-bottom:.75rem; }
    h2 { margin:0; font-size:1.15rem; flex:1; }
    .form { display:flex; gap:.5rem; flex-wrap:wrap; align-items:end; margin:.5rem 0 1rem; }
    .form ion-input, .form ion-select,
    .detail ion-input, .detail ion-select, .detail ion-textarea {
      --background:var(--surface-2,#f7f4ec); border:1px solid var(--line,#e7e2d6);
      border-radius:8px; min-width:8rem;
    }
    .err { color:#d9480f; font-weight:600; }
    .detail { border:1px solid var(--line,#e7e2d6); border-radius:12px; padding:1rem; margin:0 0 1rem;
      background:var(--surface-1,#fffdf7); }
    .detail-head { display:flex; gap:.6rem; align-items:center; flex-wrap:wrap; margin-bottom:.35rem; }
    .detail-head h3 { margin:0; font-size:1.05rem; flex:1; }
    .crumb { font-size:.85rem; margin-bottom:.5rem; }
    .crumb ion-button { vertical-align:middle; }
    .muted { color:var(--ink-2,#6f6a5e); }
    .desc { white-space:pre-wrap; margin:.25rem 0 .75rem; }
    .meta { display:flex; gap:1.25rem; flex-wrap:wrap; font-size:.9rem; margin-bottom:.75rem; }
    .actions-row { display:flex; gap:.5rem; flex-wrap:wrap; align-items:end; margin:.5rem 0 .75rem; }
    .badge { display:inline-block; padding:.1rem .55rem; border-radius:999px; font-size:.78rem;
      font-weight:600; background:var(--surface-2,#f0ece1); }
    .badge.done { background:#d3f9d8; color:#2b8a3e; }
    .badge.cancelled { background:#ffe3e3; color:#c92a2a; }
    .badge.in_progress { background:#d0ebff; color:#1971c2; }
    .badge.blocked { background:#fff3bf; color:#e67700; }
    h4 { margin:1rem 0 .4rem; font-size:.95rem; }
    .comment { border-top:1px solid var(--line,#e7e2d6); padding:.45rem 0; }
    .comment .who { font-size:.8rem; color:var(--ink-2,#6f6a5e); margin-bottom:.15rem; }
    .comment p { margin:0; white-space:pre-wrap; }
    .comment-form { display:flex; gap:.5rem; align-items:end; margin-top:.5rem; }
    .comment-form ion-textarea { flex:1; }
    .subtask { display:flex; gap:.6rem; align-items:center; border-top:1px solid var(--line,#e7e2d6);
      padding:.35rem 0; }
    .subtask .t { flex:1; }
    .empty { color:var(--ink-2,#6f6a5e); font-size:.9rem; padding:.35rem 0; }
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

  private columns: DataTableColumn[] = [
    { key: 'task_number', header: 'Nº', sortable: true, filterable: true, filterType: 'text' },
    { key: 'title', header: 'Título', sortable: true, filterable: true, filterType: 'text' },
    {
      key: 'status',
      header: 'Estado',
      sortable: true,
      filterable: true,
      filterType: 'select',
      options: Object.entries(STATUS_LABELS).map(([value, label]) => ({ value, label })),
      format: (r) => STATUS_LABELS[r.status as string] ?? (r.status as string),
    },
    {
      key: 'priority',
      header: 'Prioridad',
      sortable: true,
      filterable: true,
      filterType: 'select',
      options: Object.entries(PRIORITY_LABELS).map(([value, label]) => ({ value, label })),
    },
    {
      key: 'due_date',
      header: 'Vence',
      sortable: true,
      filterable: true,
      filterType: 'daterange',
      format: (r) => fmtDate(r.due_date as string | null),
    },
  ];

  private rowActions = [
    { id: 'detail', label: 'Detalle', icon: 'open-outline', color: 'primary' },
    { id: 'start', label: 'Iniciar', icon: 'play-circle-outline', color: 'primary' },
    { id: 'complete', label: 'Completar', icon: 'checkmark-done-outline', color: 'success' },
  ];

  async connectedCallback() {
    super.connectedCallback();
    this.ctrl = createListController<Task>(erplora(), 'tasks.tasks.list', () => this.requestUpdate(), {
      pageSize: 50,
      sort: 'created_at',
      dir: 'desc',
    });
    await this.ctrl.load();
    try {
      const events = [
        'tasks.task.created',
        'tasks.task.status_changed',
        'tasks.task.completed',
        'tasks.task.assigned',
        'tasks.comment.added',
      ];
      const offs = events.map((e) => erplora().on(e, () => this.onDomainEvent()));
      this.unsub = () => offs.forEach((off) => off());
    } catch {
      /* sin SDK (preview) → sin reactividad en vivo */
    }
  }

  disconnectedCallback() {
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
      this.myError = e instanceof Error ? e.message : 'Error cargando mis tareas';
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
      this.detailError = e instanceof Error ? e.message : 'Error cargando el detalle';
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

  private async runCommand(name: string, payload: Record<string, unknown>, refreshDetail = true) {
    this.detailBusy = true;
    this.detailError = '';
    try {
      await erplora().command(name, payload);
      await this.ctrl.load();
      if (this.view === 'mine') await this.loadMyTasks();
      if (refreshDetail && this.detail) await this.loadDetail(this.detail.id, { keepTrail: true });
    } catch (e) {
      this.detailError = e instanceof Error ? e.message : 'No se pudo ejecutar la acción';
    } finally {
      this.detailBusy = false;
    }
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
      await this.ctrl.load();
    } catch (e) {
      this.formError = e instanceof Error ? e.message : 'No se pudo crear la tarea';
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
        await this.runCommand('tasks.tasks.update_status', { task_id: task.id, new_status: 'in_progress' }, false);
        break;
      case 'complete':
        await this.runCommand('tasks.tasks.complete', { task_id: task.id }, false);
        break;
    }
  }

  private async changeStatus(newStatus: string) {
    if (!this.detail || !newStatus || newStatus === this.detail.status) return;
    await this.runCommand('tasks.tasks.update_status', { task_id: this.detail.id, new_status: newStatus });
  }

  private async completeTask() {
    if (!this.detail) return;
    await this.runCommand('tasks.tasks.complete', { task_id: this.detail.id });
  }

  private async assignTask(ref: string | null) {
    if (!this.detail) return;
    await this.runCommand('tasks.tasks.assign', {
      task_id: this.detail.id,
      assigned_to_ref: ref && ref.trim() ? ref.trim() : null,
    });
  }

  private async addComment(ev: Event) {
    ev.preventDefault();
    if (!this.detail || !this.newComment.trim()) return;
    await this.runCommand('tasks.tasks.add_comment', {
      task_id: this.detail.id,
      comment: this.newComment.trim(),
      author_ref: this.userRef || null,
    });
    if (!this.detailError) this.newComment = '';
  }

  private async addSubtask(ev: Event) {
    ev.preventDefault();
    if (!this.detail || !this.newSubtaskTitle.trim()) return;
    await this.runCommand('tasks.tasks.create', {
      title: this.newSubtaskTitle.trim(),
      description: '',
      project_id: this.detail.project_id,
      assigned_to_ref: null,
      due_date: null,
      priority: 'medium',
      parent_task_id: this.detail.id,
      created_by_ref: null,
      tags: [],
    });
    if (!this.detailError) this.newSubtaskTitle = '';
  }

  // ── Render ────────────────────────────────────────────────────────────────

  private renderBadge(status: string) {
    return html`<span class="badge ${status}">${STATUS_LABELS[status] ?? status}</span>`;
  }

  private renderDetail() {
    const t = this.detail;
    if (!t) return nothing;
    const closed = t.status === 'done' || t.status === 'cancelled';
    return html`<section class="detail">
      ${this.trail.length
        ? html`<div class="crumb">
            <ion-button size="small" fill="clear" @click=${() => this.goBack()}>← Volver</ion-button>
            <span class="muted">${this.trail.map((p) => p.task_number).join(' › ')} › ${t.task_number}</span>
          </div>`
        : nothing}
      <div class="detail-head">
        <h3>${t.task_number} — ${t.title}</h3>
        ${this.renderBadge(t.status)}
        <span class="badge">${PRIORITY_LABELS[t.priority] ?? t.priority}</span>
        <ion-button size="small" fill="clear" @click=${() => this.closeDetail()}>Cerrar</ion-button>
      </div>
      ${t.description ? html`<p class="desc">${t.description}</p>` : nothing}
      <div class="meta">
        <span><strong>Vence:</strong> ${fmtDate(t.due_date)}</span>
        <span><strong>Completada:</strong> ${fmtDate(t.completed_at)}</span>
        <span><strong>Asignada a:</strong> ${t.assigned_to_ref ?? '—'}</span>
        <span><strong>Creada:</strong> ${fmtDate(t.created_at)}</span>
      </div>

      <div class="actions-row">
        <ion-select label="Estado" label-placement="stacked" .value=${t.status}
          ?disabled=${this.detailBusy}
          @ionChange=${(e: any) => this.changeStatus(e.target.value)}>
          ${Object.entries(STATUS_LABELS).map(
            ([k, v]) => html`<ion-select-option .value=${k}>${v}</ion-select-option>`,
          )}
        </ion-select>
        <ion-button size="small" color="success" ?disabled=${this.detailBusy || closed}
          @click=${() => this.completeTask()}>Completar</ion-button>
        <ion-input placeholder="uuid del usuario…" .value=${this.assignRef}
          @ionInput=${(e: any) => (this.assignRef = e.target.value)}></ion-input>
        <ion-button size="small" ?disabled=${this.detailBusy}
          @click=${() => this.assignTask(this.assignRef)}>Asignar</ion-button>
        ${this.userRef && this.userRef !== t.assigned_to_ref
          ? html`<ion-button size="small" fill="outline" ?disabled=${this.detailBusy}
              @click=${() => this.assignTask(this.userRef)}>Asignármela</ion-button>`
          : nothing}
        ${t.assigned_to_ref
          ? html`<ion-button size="small" fill="outline" color="medium" ?disabled=${this.detailBusy}
              @click=${() => this.assignTask(null)}>Desasignar</ion-button>`
          : nothing}
      </div>
      ${this.detailError ? html`<p class="err">${this.detailError}</p>` : nothing}

      <h4>Subtareas (${this.subtasks.length})</h4>
      ${this.subtasks.length
        ? this.subtasks.map(
            (s) => html`<div class="subtask">
              <span class="t">${s.task_number} — ${s.title}</span>
              ${this.renderBadge(s.status)}
              <ion-button size="small" fill="clear" @click=${() => this.drillDown(s)}>Abrir</ion-button>
            </div>`,
          )
        : html`<p class="empty">Sin subtareas.</p>`}
      <form class="comment-form" @submit=${(e: Event) => this.addSubtask(e)}>
        <ion-input placeholder="Nueva subtarea…" .value=${this.newSubtaskTitle}
          @ionInput=${(e: any) => (this.newSubtaskTitle = e.target.value)}></ion-input>
        <ion-button type="submit" size="small" ?disabled=${this.detailBusy || !this.newSubtaskTitle}>
          Añadir subtarea</ion-button>
      </form>

      <h4>Comentarios (${this.comments.length})</h4>
      ${this.comments.length
        ? this.comments.map(
            (c) => html`<div class="comment">
              <div class="who">${c.author_ref ?? 'anónimo'} · ${String(c.created_at).slice(0, 16).replace('T', ' ')}</div>
              <p>${c.comment}</p>
            </div>`,
          )
        : html`<p class="empty">Sin comentarios.</p>`}
      <form class="comment-form" @submit=${(e: Event) => this.addComment(e)}>
        <ion-textarea auto-grow rows="1" placeholder="Añadir comentario…" .value=${this.newComment}
          @ionInput=${(e: any) => (this.newComment = e.target.value)}></ion-textarea>
        <ion-button type="submit" size="small" ?disabled=${this.detailBusy || !this.newComment.trim()}>
          Comentar</ion-button>
      </form>
    </section>`;
  }

  private renderAll() {
    return html`<form class="form" @submit=${(e: Event) => this.createTask(e)}>
        <ion-input placeholder="Nueva tarea…" .value=${this.newTitle} @ionInput=${(e: any) => (this.newTitle = e.target.value)}></ion-input>
        <ion-select placeholder="Prioridad…" .value=${this.newPriority} @ionChange=${(e: any) => (this.newPriority = e.target.value)}>
          ${Object.entries(PRIORITY_LABELS).map(
            ([k, v]) => html`<ion-select-option .value=${k}>${v}</ion-select-option>`,
          )}
        </ion-select>
        <ion-button type="submit" size="small" ?disabled=${this.saving || !this.newTitle}>${this.saving ? 'Guardando…' : 'Añadir'}</ion-button>
      </form>
      ${this.formError ? html`<p class="err">${this.formError}</p>` : nothing}
      ${this.ctrl?.error ? html`<p class="err">${this.ctrl.error}</p>` : nothing}
      <ok-data-table .serverSide=${true} .columns=${this.columns} .rows=${this.ctrl?.rows ?? []} .total=${this.ctrl?.total ?? 0} .page=${this.ctrl?.state.page ?? 0} .pageSize=${this.ctrl?.state.pageSize ?? 50} .sort=${this.ctrl?.state.sort} .sortDir=${this.ctrl?.state.dir ?? 'desc'} .searchable=${true} .searchPlaceholder=${"Buscar nº o título…"} .actions=${this.rowActions} .emptyMessage=${this.ctrl?.loading ? 'Cargando…' : 'Sin tareas.'} @rowAction=${(e: CustomEvent) => this.onRowAction(e)} @pageChange=${(e: CustomEvent<number>) => this.ctrl.setPage(e.detail)} @sortChange=${(e: CustomEvent<{ sort: string; dir: 'asc' | 'desc' }>) => this.ctrl.setSort(e.detail.sort, e.detail.dir)} @searchChange=${(e: CustomEvent<string>) => this.ctrl.setSearch(e.detail)} @filterChange=${(e: CustomEvent<{ col: string; value: unknown }>) => this.ctrl.setFilter(e.detail.col, e.detail.value)}></ok-data-table>`;
  }

  private renderMine() {
    if (!this.userRef) {
      return html`<p class="empty">Sin sesión de usuario en el shell: la vista "Mis tareas" no está disponible.</p>`;
    }
    return html`${this.myError ? html`<p class="err">${this.myError}</p>` : nothing}
      <ok-data-table .columns=${this.columns} .rows=${this.myTasks as unknown as Record<string, unknown>[]} .searchKeys=${['task_number', 'title']} .searchPlaceholder=${"Buscar nº o título…"} .actions=${this.rowActions} .emptyMessage=${this.myLoading ? 'Cargando…' : 'Sin tareas abiertas asignadas a ti.'} @rowAction=${(e: CustomEvent) => this.onRowAction(e)}></ok-data-table>`;
  }

  render() {
    return html`<div>
        <header>
          <h2>Tareas</h2>
          <ion-segment .value=${this.view} @ionChange=${(e: any) => this.setView(e.detail.value)}>
            <ion-segment-button value="all"><ion-label>Todas</ion-label></ion-segment-button>
            ${this.userRef
              ? html`<ion-segment-button value="mine"><ion-label>Mis tareas</ion-label></ion-segment-button>`
              : nothing}
          </ion-segment>
        </header>
        ${this.renderDetail()}
        ${this.view === 'all' ? this.renderAll() : this.renderMine()}
      </div>`;
  }
}

define('erp-tasks-list', ErpTasksList);
