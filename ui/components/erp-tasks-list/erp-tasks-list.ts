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
}

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

export class ErpTasksList extends LitElement {
  static styles = css`
    :host { display:block; font-family: system-ui, sans-serif; color: var(--ink, #1c1b18); }
    header { display:flex; gap:.5rem; align-items:center; margin-bottom:.75rem; }
    h2 { margin:0; font-size:1.15rem; flex:1; }
    .form { display:flex; gap:.5rem; flex-wrap:wrap; align-items:end; margin:.5rem 0 1rem; }
    .form ion-input, .form ion-select { --background:var(--surface-2,#f7f4ec); border:1px solid var(--line,#e7e2d6); border-radius:8px; min-width:8rem; }
    .err { color:#d9480f; font-weight:600; }
  `;

  @state() newTitle = '';

  @state() newPriority = 'medium';

  @state() saving = false;

  @state() formError = '';

  @state() tick = 0;

  private ctrl!: ListController<Task>;

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
    await this.ctrl.load();
    try {
      const off1 = erplora().on('tasks.task.created', () => this.ctrl.load());
      const off2 = erplora().on('tasks.task.status_changed', () => this.ctrl.load());
      const off3 = erplora().on('tasks.task.completed', () => this.ctrl.load());
      const off4 = erplora().on('tasks.task.assigned', () => this.ctrl.load());
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

  render() {
    return html`<div>
        <header>
          <h2>Tareas</h2>
        </header>
        <form class="form" @submit=${(e) => this.createTask(e)}>
          <ion-input placeholder="Nueva tarea…" .value=${this.newTitle} @ionInput=${(e: any) => (this.newTitle = e.target.value)}></ion-input>
          <ion-select placeholder="Prioridad…" .value=${this.newPriority} @ionChange=${(e: any) => (this.newPriority = e.target.value)}>
            <ion-select-option value="low">Low</ion-select-option>
            <ion-select-option value="medium">Medium</ion-select-option>
            <ion-select-option value="high">High</ion-select-option>
            <ion-select-option value="urgent">Urgent</ion-select-option>
          </ion-select>
          <ion-button type="submit" size="small" ?disabled=${this.saving || !this.newTitle}>${this.saving ? 'Guardando…' : 'Añadir'}</ion-button>
        </form>
        ${this.formError ? html`<p class="err">${this.formError}</p>` : nothing}
        ${this.ctrl?.error ? html`<p class="err">${this.ctrl.error}</p>` : nothing}
        <ok-data-table .serverSide=${true} .columns=${this.columns} .rows=${this.ctrl?.rows ?? []} .total=${this.ctrl?.total ?? 0} .page=${this.ctrl?.state.page ?? 0} .pageSize=${this.ctrl?.state.pageSize ?? 50} .sort=${this.ctrl?.state.sort} .sortDir=${this.ctrl?.state.dir ?? 'desc'} .searchable=${true} .searchPlaceholder=${"Buscar nº o título…"} .emptyMessage=${this.ctrl?.loading ? 'Cargando…' : 'Sin tareas.'} @pageChange=${(e: CustomEvent<number>) => this.ctrl.setPage(e.detail)} @sortChange=${(e: CustomEvent<{ sort: string; dir: 'asc' | 'desc' }>) => this.ctrl.setSort(e.detail.sort, e.detail.dir)} @searchChange=${(e: CustomEvent<string>) => this.ctrl.setSearch(e.detail)} @filterChange=${(e: CustomEvent<{ col: string; value: unknown }>) => this.ctrl.setFilter(e.detail.col, e.detail.value)}></ok-data-table>
      </div>`;
  }
}

define('erp-tasks-list', ErpTasksList);
