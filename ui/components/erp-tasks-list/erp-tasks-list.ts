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
  status: string;
  priority: string;
  assigned_to_ref: string | null;
  due_date: string | null;
  tags: string;
}

type ViewTab = 'all' | 'employee' | 'area';

const STATUS_LABELS: Record<string, string> = {
  todo: 'To Do',
  in_progress: 'In Progress',
  blocked: 'Blocked',
  done: 'Done',
  cancelled: 'Cancelled',
};

function erplora(): ErploraClientLike {
  const c = (globalThis as { erplora?: ErploraClientLike }).erplora;
  if (!c) throw new Error('erplora SDK no inicializado por el shell');
  return c;
}

function parseTags(raw: string): string[] {
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

export class ErpTasksList extends LitElement {
  static styles = css`
    :host { display:block; font-family: system-ui, sans-serif; color: var(--ink, #1c1b18); }
    header { display:flex; gap:.5rem; align-items:center; margin-bottom:.75rem; }
    h2 { margin:0; font-size:1.15rem; flex:1; }
    .tabs { display:flex; gap:.25rem; margin-bottom:.75rem; border-bottom:1px solid var(--line,#e7e2d6); }
    .tab { padding:.35rem .75rem; border:none; background:none; cursor:pointer; font-size:.875rem;
           color:var(--ink-2,#6b6860); border-bottom:2px solid transparent; margin-bottom:-1px; }
    .tab.active { color:var(--ink,#1c1b18); border-bottom-color:var(--brand,#3b6bff); font-weight:600; }
    .form { display:flex; gap:.5rem; flex-wrap:wrap; align-items:end; margin:.5rem 0 1rem; }
    .form ion-input, .form ion-select { --background:var(--surface-2,#f7f4ec); border:1px solid var(--line,#e7e2d6); border-radius:8px; min-width:8rem; }
    .filter-row { display:flex; gap:.5rem; align-items:end; margin:.5rem 0 1rem; flex-wrap:wrap; }
    .filter-row ion-input { --background:var(--surface-2,#f7f4ec); border:1px solid var(--line,#e7e2d6); border-radius:8px; min-width:14rem; }
    .err { color:#d9480f; font-weight:600; }
    .task-card { border:1px solid var(--line,#e7e2d6); border-radius:8px; padding:.6rem .75rem;
                 margin-bottom:.5rem; display:flex; flex-direction:column; gap:.2rem; }
    .task-card-header { display:flex; gap:.5rem; align-items:center; }
    .task-card-num { font-size:.75rem; color:var(--ink-2,#6b6860); }
    .task-card-title { font-weight:600; flex:1; }
    .badge { display:inline-block; padding:.1rem .4rem; border-radius:4px; font-size:.75rem; }
    .badge-todo { background:#f1f0ee; color:#6b6860; }
    .badge-in_progress { background:#e0e7ff; color:#3b52b4; }
    .badge-blocked { background:#fee2e2; color:#b91c1c; }
    .badge-done { background:#dcfce7; color:#15803d; }
    .badge-cancelled { background:#f1f0ee; color:#6b6860; text-decoration:line-through; }
    .badge-low { background:#f1f0ee; color:#6b6860; }
    .badge-medium { background:#fef9c3; color:#854d0e; }
    .badge-high { background:#fee2e2; color:#b91c1c; }
    .badge-urgent { background:#fce7f3; color:#9d174d; }
    .task-card-meta { display:flex; gap:.5rem; font-size:.75rem; color:var(--ink-2,#6b6860); flex-wrap:wrap; }
    .tag-chip { background:var(--surface-2,#f7f4ec); border-radius:4px; padding:.1rem .35rem; font-size:.7rem; }
    .empty { text-align:center; color:var(--ink-2,#6b6860); padding:2rem; }
  `;

  @state() view: ViewTab = 'all';

  @state() newTitle = '';

  @state() newPriority = 'medium';

  @state() newArea = '';

  @state() saving = false;

  @state() formError = '';

  @state() employeeRef = '';

  @state() areaTag = '';

  private ctrl!: ListController<Task>;

  private employeeCtrl!: ListController<Task>;

  private unsub?: () => void;

  private columns: DataTableColumn[] = [
    { key: 'task_number', header: 'Nº', sortable: true, filterable: true, filterType: 'text' },
    { key: 'title', header: 'Título', sortable: true, filterable: true, filterType: 'text' },
    {
      key: 'status',
      header: 'Estado',
      sortable: true,
      filterable: true,
      filterType: 'select',
      options: [
        { value: 'todo', label: 'To Do' },
        { value: 'in_progress', label: 'In Progress' },
        { value: 'blocked', label: 'Blocked' },
        { value: 'done', label: 'Done' },
        { value: 'cancelled', label: 'Cancelled' },
      ],
      format: (r) => STATUS_LABELS[r.status as string] ?? (r.status as string),
    },
    {
      key: 'priority',
      header: 'Prioridad',
      sortable: true,
      filterable: true,
      filterType: 'select',
      options: [
        { value: 'low', label: 'Low' },
        { value: 'medium', label: 'Medium' },
        { value: 'high', label: 'High' },
        { value: 'urgent', label: 'Urgent' },
      ],
    },
    {
      key: 'due_date',
      header: 'Vence',
      sortable: true,
      filterable: true,
      filterType: 'daterange',
      format: (r) => (r.due_date ? String(r.due_date).slice(0, 10) : '—'),
    },
  ];

  // TODO-LIT: componentWillLoad → connectedCallback. Recuerda: connectedCallback se dispara
  // en CADA reconexión al DOM (no solo en el primer montaje). Si la init debe correr una
  // sola vez tras el primer render, considera firstUpdated() en su lugar.
  async connectedCallback() {
    super.connectedCallback();
    this.ctrl = createListController<Task>(erplora(), 'tasks.tasks.list', () => this.requestUpdate(), {
      pageSize: 50,
      sort: 'created_at',
      dir: 'desc',
    });
    this.employeeCtrl = createListController<Task>(erplora(), 'tasks.tasks.list', () => this.requestUpdate(), {
      pageSize: 200,
      sort: 'due_date',
      dir: 'asc',
    });
    await this.ctrl.load();
    try {
      const off1 = erplora().on('tasks.task.created', () => { this.ctrl.load(); if (this.view === 'employee') this.employeeCtrl.load(); });
      const off2 = erplora().on('tasks.task.status_changed', () => { this.ctrl.load(); if (this.view === 'employee') this.employeeCtrl.load(); });
      const off3 = erplora().on('tasks.task.completed', () => { this.ctrl.load(); if (this.view === 'employee') this.employeeCtrl.load(); });
      const off4 = erplora().on('tasks.task.assigned', () => { this.ctrl.load(); if (this.view === 'employee') this.employeeCtrl.load(); });
      this.unsub = () => {
        off1();
        off2();
        off3();
        off4();
      };
    } catch {
      /* sin SDK (preview) → sin reactividad en vivo */
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.unsub?.();
  }

  private async createTask(ev: Event) {
    ev.preventDefault();
    if (!this.newTitle.trim()) return;
    this.saving = true;
    this.formError = '';
    try {
      const tags: string[] = this.newArea.trim() ? [this.newArea.trim()] : [];
      await erplora().command('tasks.tasks.create', {
        title: this.newTitle.trim(),
        description: '',
        project_id: null,
        assigned_to_ref: null,
        due_date: null,
        priority: this.newPriority,
        parent_task_id: null,
        created_by_ref: null,
        tags,
      });
      this.newTitle = '';
      this.newPriority = 'medium';
      this.newArea = '';
      await this.ctrl.load();
    } catch (e) {
      this.formError = e instanceof Error ? e.message : 'No se pudo crear la tarea';
    } finally {
      this.saving = false;
    }
  }

  private async applyEmployeeFilter() {
    if (!this.employeeRef.trim()) return;
    this.employeeCtrl.setFilter('assigned_to_ref', this.employeeRef.trim());
    await this.employeeCtrl.load();
  }

  private get areaRows(): Task[] {
    const tag = this.areaTag.trim().toLowerCase();
    if (!tag) return this.ctrl.rows;
    return this.ctrl.rows.filter((r) => parseTags(r.tags).some((t) => t.toLowerCase() === tag));
  }

  private renderTabAll() {
    return html`
      <form class="form" @submit=${(e: Event) => this.createTask(e)}>
        <ion-input placeholder="Nueva tarea…" .value=${this.newTitle} @ionInput=${(e: any) => (this.newTitle = e.target.value)}></ion-input>
        <ion-select placeholder="Prioridad…" .value=${this.newPriority} @ionChange=${(e: any) => (this.newPriority = e.target.value)}>
          <ion-select-option value="low">Low</ion-select-option>
          <ion-select-option value="medium">Medium</ion-select-option>
          <ion-select-option value="high">High</ion-select-option>
          <ion-select-option value="urgent">Urgent</ion-select-option>
        </ion-select>
        <ion-input placeholder="Área (cocina, obrador…)" .value=${this.newArea} @ionInput=${(e: any) => (this.newArea = e.target.value)}></ion-input>
        <ion-button type="submit" size="small" ?disabled=${this.saving || !this.newTitle}>${this.saving ? 'Guardando…' : 'Añadir'}</ion-button>
      </form>
      ${this.formError ? html`<p class="err">${this.formError}</p>` : nothing}
      ${this.ctrl?.error ? html`<p class="err">${this.ctrl.error}</p>` : nothing}
      <ok-data-table
        .serverSide=${true}
        .columns=${this.columns}
        .rows=${this.ctrl?.rows ?? []}
        .total=${this.ctrl?.total ?? 0}
        .page=${this.ctrl?.state.page ?? 0}
        .pageSize=${this.ctrl?.state.pageSize ?? 50}
        .sort=${this.ctrl?.state.sort}
        .sortDir=${this.ctrl?.state.dir ?? 'desc'}
        .searchable=${true}
        .searchPlaceholder=${'Buscar nº o título…'}
        .emptyMessage=${this.ctrl?.loading ? 'Cargando…' : 'Sin tareas.'}
        @pageChange=${(e: CustomEvent<number>) => this.ctrl.setPage(e.detail)}
        @sortChange=${(e: CustomEvent<{ sort: string; dir: 'asc' | 'desc' }>) => this.ctrl.setSort(e.detail.sort, e.detail.dir)}
        @searchChange=${(e: CustomEvent<string>) => this.ctrl.setSearch(e.detail)}
        @filterChange=${(e: CustomEvent<{ col: string; value: unknown }>) => this.ctrl.setFilter(e.detail.col, e.detail.value)}
      ></ok-data-table>
    `;
  }

  private renderTaskCard(task: Task) {
    const tags = parseTags(task.tags);
    return html`
      <div class="task-card">
        <div class="task-card-header">
          <span class="task-card-num">${task.task_number}</span>
          <span class="task-card-title">${task.title}</span>
          <span class="badge badge-${task.status}">${STATUS_LABELS[task.status] ?? task.status}</span>
          <span class="badge badge-${task.priority}">${task.priority}</span>
        </div>
        <div class="task-card-meta">
          ${task.assigned_to_ref ? html`<span>Asignado: ${task.assigned_to_ref}</span>` : nothing}
          ${task.due_date ? html`<span>Vence: ${String(task.due_date).slice(0, 10)}</span>` : nothing}
          ${tags.map((t) => html`<span class="tag-chip">${t}</span>`)}
        </div>
      </div>
    `;
  }

  private renderTabEmployee() {
    const rows = this.employeeCtrl?.rows ?? [];
    return html`
      <div class="filter-row">
        <ion-input
          placeholder="UUID del empleado…"
          .value=${this.employeeRef}
          @ionInput=${(e: any) => (this.employeeRef = e.target.value)}
        ></ion-input>
        <ion-button size="small" @click=${() => this.applyEmployeeFilter()}>Filtrar</ion-button>
      </div>
      ${this.employeeCtrl?.error ? html`<p class="err">${this.employeeCtrl.error}</p>` : nothing}
      ${this.employeeCtrl?.loading ? html`<p>Cargando…</p>` : nothing}
      ${!this.employeeCtrl?.loading && rows.length === 0 && this.employeeRef
        ? html`<p class="empty">Sin tareas para este empleado.</p>`
        : nothing}
      ${rows.map((t) => this.renderTaskCard(t))}
    `;
  }

  private renderTabArea() {
    const rows = this.areaRows;
    return html`
      <div class="filter-row">
        <ion-input
          placeholder="Área (cocina, obrador, recepción…)"
          .value=${this.areaTag}
          @ionInput=${(e: any) => { this.areaTag = e.target.value; this.requestUpdate(); }}
        ></ion-input>
      </div>
      ${this.ctrl?.loading ? html`<p>Cargando…</p>` : nothing}
      ${!this.ctrl?.loading && rows.length === 0
        ? html`<p class="empty">${this.areaTag ? 'Sin tareas para esta área.' : 'Escribe un área para filtrar.'}</p>`
        : nothing}
      ${rows.map((t) => this.renderTaskCard(t))}
    `;
  }

  render() {
    return html`
      <div>
        <header>
          <h2>Tareas</h2>
        </header>
        <div class="tabs">
          <button class="tab ${this.view === 'all' ? 'active' : ''}" @click=${() => (this.view = 'all')}>Todas</button>
          <button class="tab ${this.view === 'employee' ? 'active' : ''}" @click=${() => (this.view = 'employee')}>Por empleado</button>
          <button class="tab ${this.view === 'area' ? 'active' : ''}" @click=${() => (this.view = 'area')}>Por área</button>
        </div>
        ${this.view === 'all' ? this.renderTabAll() : nothing}
        ${this.view === 'employee' ? this.renderTabEmployee() : nothing}
        ${this.view === 'area' ? this.renderTabArea() : nothing}
      </div>
    `;
  }
}

define('erp-tasks-list', ErpTasksList);
