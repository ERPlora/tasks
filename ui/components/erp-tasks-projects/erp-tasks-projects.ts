import { LitElement, html, css, nothing } from 'lit';
import type { PropertyValues } from 'lit';
import { state } from 'lit/decorators.js';
import { define } from '@erplora/outfitkit/define';
import '@erplora/outfitkit/ok-data-table';
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

interface TaskProject {
  id: string;
  code: string;
  name: string;
  color: string;
  is_active: number;
}

/** A task as the project sheet lists it (a slice of `tasks.tasks.list`). */
interface ProjectTask {
  id: string;
  task_number: string;
  title: string;
  status: string;
}

/** How many of a project's tasks the sheet lists; the rest are behind the Tasks tab. */
const PROJECT_TASKS_PAGE = 50;

function erplora(): ErploraClientLike {
  const c = (globalThis as { erplora?: ErploraClientLike }).erplora;
  if (!c) throw new Error('erplora SDK no inicializado por el shell');
  return c;
}

/** Traducción del catálogo `ui` (idioma activo, fallback locale→en→clave). */
function t(key: string, params?: Record<string, unknown>): string {
  return erplora().t(CATALOG, key, params);
}

export class ErpTasksProjects extends LitElement {
  static styles = css`
    /* Cadena de altura: sin ella, el modo fill de la tabla no tiene alto que llenar. */
    :host { display:flex; flex-direction:column; height:100%; min-height:0; font-family: system-ui, sans-serif; color: var(--ion-text-color, #1c1b18); }
    .page { display:flex; flex-direction:column; min-height:0; flex:1 1 auto; }
    .page > ok-data-table { flex:1 1 auto; min-height:0; }
    /* El alta vive en el panel lateral de la tabla: columna estrecha, no fila que se desborda. */
    .form { display:flex; flex-direction:column; gap:.7rem; }
    .form ion-button { align-self:flex-end; }
    .err { color:#d9480f; font-weight:600; }
    /* tasks#43 — the project sheet: same frame as the task detail in the Tasks tab. It never shrinks
       (the table below it does) and scrolls on its own on a short screen. */
    .detail { flex:0 0 auto; max-height:70vh; overflow:auto; border:1px solid var(--ion-border-color,#e7e2d6);
      border-radius:12px; padding:1rem; margin:0 0 1rem; background:var(--ion-card-background,#fffdf7); }
    .detail-head { display:flex; gap:.6rem; align-items:center; flex-wrap:wrap; margin-bottom:.35rem; }
    .detail-head h3 { margin:0; font-size:1.05rem; flex:1; min-width:0; overflow-wrap:anywhere; }
    .swatch { width:.9rem; height:.9rem; border-radius:50%; flex:0 0 auto;
      border:1px solid var(--ion-border-color,#e7e2d6); }
    .muted { color:var(--ion-color-medium,#6f6a5e); font-size:.9rem; margin:0 0 .75rem; }
    .badge { display:inline-block; padding:.1rem .55rem; border-radius:999px; font-size:.78rem; font-weight:600;
      background:var(--ok-surface-2, var(--ion-color-step-50, rgba(var(--ion-text-color-rgb, 24, 24, 27), 0.04))); }
    .badge.active, .badge.done { background:#d3f9d8; color:#2b8a3e; }
    .badge.cancelled { background:#ffe3e3; color:#c92a2a; }
    .badge.in_progress { background:#d0ebff; color:#1971c2; }
    .badge.blocked { background:#fff3bf; color:#e67700; }
    .edit, .add-task { display:flex; gap:.75rem; flex-wrap:wrap; align-items:end; margin:.5rem 0 .75rem; }
    .edit ion-input, .add-task ion-input { flex:1 1 11rem; min-width:9rem; }
    h4 { margin:1rem 0 .4rem; font-size:.95rem; }
    .ptask { display:flex; gap:.6rem; align-items:center; border-top:1px solid var(--ion-border-color,#e7e2d6); padding:.35rem 0; }
    .ptask .t { flex:1; min-width:0; overflow-wrap:anywhere; }
    .empty { color:var(--ion-color-medium,#6f6a5e); font-size:.9rem; padding:.35rem 0; margin:0; }
  `;

  @state() newCode = '';

  @state() newName = '';

  @state() newColor = '';

  @state() saving = false;

  /** What «Add» was refused: painted inside the panel's form, never on the page (pm#513). */
  @state() formError = '';

  // ── Project sheet (tasks#43): tapping a card opens the project ──
  @state() detail: TaskProject | null = null;

  @state() editName = '';

  @state() editColor = '';

  @state() detailBusy = false;

  /** What a Save / Activate / Add task was refused: painted inside the sheet (pm#513). */
  @state() detailError = '';

  @state() projectTasks: ProjectTask[] = [];

  @state() projectTasksTotal = 0;

  @state() projectTasksLoading = false;

  @state() projectTasksError = '';

  @state() newTaskTitle = '';

  /** Which project the last tasks request was for: a late answer for another one is dropped. */
  private tasksRequestFor = '';

  private ctrl!: ListController<TaskProject>;

  private unsub?: () => void;

  // Getter (no campo): se re-evalúa en cada render, así los textos cambian con el idioma activo
  // (ADR-0055). `connectedCallback` re-renderiza al recibir `erplora:locale-changed`.
  private get columns(): DataTableColumn[] {
    return [
      { key: 'code', header: t('ui.colCode'), sortable: true, filterable: true, filterType: 'text' },
      { key: 'name', header: t('ui.colName'), sortable: true, filterable: true, filterType: 'text' },
      { key: 'color', header: t('ui.colColor'), sortable: true, filterable: true, filterType: 'text', format: (r) => (r.color as string) || '—' },
      {
        key: 'is_active',
        header: t('ui.colActive'),
        sortable: true,
        filterable: true,
        filterType: 'select',
        options: [
          { value: '1', label: t('ui.yes') },
          { value: '0', label: t('ui.no') },
        ],
        format: (r) => (r.is_active ? t('ui.yes') : t('ui.no')),
      },
    ];
  }

  /** tasks#43 — the card carries a visible way in, like the Tasks cards. */
  private get rowActions() {
    return [{ id: 'open', label: t('ui.actionOpen'), icon: 'open-outline', color: 'primary' }];
  }

  // Re-render on a shell language change (ADR-0055): the `columns`/`rowActions` getters and the
  // template text are re-evaluated with the new `erplora.locale`.
  private readonly onLocaleChange = (): void => this.requestUpdate();

  // TODO-LIT: componentWillLoad → connectedCallback. Recuerda: connectedCallback se dispara
  // en CADA reconexión al DOM (no solo en el primer montaje). Si la init debe correr una
  // sola vez tras el primer render, considera firstUpdated() en su lugar.
  async connectedCallback() {
    super.connectedCallback();
    window.addEventListener('erplora:locale-changed', this.onLocaleChange);
    this.ctrl = createListController<TaskProject>(erplora(), 'tasks.projects.list', () => this.requestUpdate(), {
      pageSize: 50,
      sort: 'created_at',
      dir: 'desc',
    });
    await this.ctrl.load();
    try {
      // One subscription per event, its literal IN the call (ADR-0127).
      const offs = [
        erplora().on('tasks.project.created', () => this.ctrl.load()),
        erplora().on('tasks.project.updated', () => this.ctrl.load()),
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

  /** Referencia al panel lateral de la tabla: guardar lo cierra. */
  private dataTable(): { open(p?: 'filters' | 'create'): void; close(): void } | null {
    return this.renderRoot.querySelector('ok-data-table') as
      | { open(p?: 'filters' | 'create'): void; close(): void }
      | null;
  }

  private async createProject(ev: Event) {
    ev.preventDefault();
    if (!this.newCode.trim() || !this.newName.trim()) return;
    this.saving = true;
    this.formError = '';
    try {
      await erplora().command('tasks.projects.create', {
        code: this.newCode.trim(),
        name: this.newName.trim(),
        color: this.newColor.trim(),
        owner_ref: null,
      });
      this.newCode = '';
      this.newName = '';
      this.newColor = '';
      this.dataTable()?.close();
      await this.ctrl.load();
    } catch (e) {
      this.formError = e instanceof Error ? e.message : t('ui.errCreateProject');
    } finally {
      this.saving = false;
    }
  }

  // ── Project sheet (tasks#43) ─────────────────────────────────────────────

  private openProject(row: Record<string, unknown>) {
    const project = row as unknown as TaskProject;
    this.showProject(project);
    void this.loadProjectTasks(project.id);
  }

  private showProject(project: TaskProject) {
    const switching = this.detail?.id !== project.id;
    this.detail = { ...project };
    this.editName = project.name ?? '';
    this.editColor = project.color ?? '';
    if (switching) {
      // Another project: nothing of the previous one may stay on screen (rv-invoice-126).
      this.detailError = '';
      this.newTaskTitle = '';
      this.projectTasks = [];
      this.projectTasksTotal = 0;
      this.projectTasksError = '';
    }
  }

  private closeProject() {
    this.detail = null;
    this.tasksRequestFor = '';
    this.detailError = '';
    this.newTaskTitle = '';
    this.projectTasks = [];
    this.projectTasksTotal = 0;
    this.projectTasksError = '';
    this.projectTasksLoading = false;
  }

  private async loadProjectTasks(projectId: string) {
    this.tasksRequestFor = projectId;
    this.projectTasksLoading = true;
    this.projectTasksError = '';
    try {
      const page = await erplora().queryPage<ProjectTask>('tasks.tasks.list', {
        filters: { project_id: projectId },
        sort: 'created_at',
        dir: 'desc',
        limit: PROJECT_TASKS_PAGE,
        offset: 0,
      });
      if (this.tasksRequestFor !== projectId) return;
      this.projectTasks = page?.rows ?? [];
      this.projectTasksTotal = page?.total ?? this.projectTasks.length;
    } catch (e) {
      if (this.tasksRequestFor !== projectId) return;
      this.projectTasks = [];
      this.projectTasksTotal = 0;
      this.projectTasksError = e instanceof Error ? e.message : t('ui.errLoadProjectTasks');
    } finally {
      if (this.tasksRequestFor === projectId) this.projectTasksLoading = false;
    }
  }

  /** Sends the edit and re-reads the list; the sheet then shows what the server holds. */
  private async updateProject(changes: { name: string; color: string; is_active: number }) {
    const project = this.detail;
    if (!project) return;
    this.detailBusy = true;
    this.detailError = '';
    try {
      await erplora().command('tasks.projects.update', { project_id: project.id, ...changes });
      await this.ctrl.load();
      // The command rewrites every editable field and the code never changes: what was accepted
      // IS what the server holds, also when a filter leaves the project off the current page.
      if (this.detail?.id === project.id) this.showProject({ ...project, ...changes });
    } catch (e) {
      this.detailError = e instanceof Error ? e.message : t('ui.errUpdateProject');
    } finally {
      this.detailBusy = false;
    }
  }

  private async saveProject(ev: Event) {
    ev.preventDefault();
    const project = this.detail;
    const name = this.editName.trim();
    if (!project || !name || this.detailBusy) return;
    await this.updateProject({ name, color: this.editColor.trim(), is_active: project.is_active ? 1 : 0 });
  }

  /** Activate / Deactivate keeps the SAVED name and colour: unsaved typing is not sent with it. */
  private async toggleActive() {
    const project = this.detail;
    if (!project || this.detailBusy) return;
    await this.updateProject({ name: project.name, color: project.color ?? '', is_active: project.is_active ? 0 : 1 });
  }

  private async addTask(ev: Event) {
    ev.preventDefault();
    const project = this.detail;
    const title = this.newTaskTitle.trim();
    if (!project || !title || this.detailBusy) return;
    this.detailBusy = true;
    this.detailError = '';
    try {
      await erplora().command('tasks.tasks.create', { title, project_id: project.id });
      this.newTaskTitle = '';
      if (this.detail?.id === project.id) await this.loadProjectTasks(project.id);
    } catch (e) {
      this.detailError = e instanceof Error ? e.message : t('ui.errCreateTask');
    } finally {
      this.detailBusy = false;
    }
  }

  private statusLabel(status: string): string {
    const key = `ui.status.${status}`;
    const label = t(key);
    return label === key ? status : label;
  }

  private renderProjectTasks() {
    if (this.projectTasksLoading && !this.projectTasks.length) {
      return html`<p class="empty" data-testid="tasks-project-tasks-loading">${t('ui.loading')}</p>`;
    }
    if (this.projectTasksError) {
      return html`<p class="err" data-testid="tasks-project-tasks-error">${this.projectTasksError}</p>`;
    }
    if (!this.projectTasks.length) {
      return html`<p class="empty" data-testid="tasks-project-tasks-empty">${t('ui.emptyProjectTasks')}</p>`;
    }
    return html`${this.projectTasks.map(
        (task) => html`<div class="ptask" data-testid="tasks-project-task">
          <span class="t">${task.task_number} — ${task.title}</span>
          <span class="badge ${task.status}">${this.statusLabel(task.status)}</span>
        </div>`,
      )}
      ${this.projectTasksTotal > this.projectTasks.length
        ? html`<p class="empty">${t('ui.projectTasksMore', { shown: this.projectTasks.length, total: this.projectTasksTotal })}</p>`
        : nothing}`;
  }

  private renderDetail() {
    const project = this.detail;
    if (!project) return nothing;
    const active = !!project.is_active;
    return html`<section class="detail" data-testid="tasks-project-detail">
      <div class="detail-head">
        ${project.color ? html`<span class="swatch" style="background:${project.color}"></span>` : nothing}
        <h3>${project.name}</h3>
        <span class="badge ${active ? 'active' : ''}" data-testid="tasks-project-state">${active ? t('ui.projectActive') : t('ui.projectInactive')}</span>
        <ion-button size="small" fill="clear" data-testid="tasks-project-close" @click=${() => this.closeProject()}>${t('ui.close')}</ion-button>
      </div>
      <p class="muted">${t('ui.colCode')}: ${project.code}</p>
      <form class="edit" @submit=${(e: Event) => this.saveProject(e)}>
        <ion-input mode="md" fill="outline" label-placement="floating" label=${t('ui.colName')} .value=${this.editName}
          @ionInput=${(e: any) => (this.editName = e.target.value ?? '')}></ion-input>
        <ion-input mode="md" fill="outline" label-placement="floating" label=${t('ui.colColor')} placeholder=${t('ui.colorPlaceholder')} .value=${this.editColor}
          @ionInput=${(e: any) => (this.editColor = e.target.value ?? '')}></ion-input>
        <ion-button type="submit" size="small" data-testid="tasks-project-save" ?disabled=${this.detailBusy || !this.editName.trim()}>${this.detailBusy ? t('ui.saving') : t('ui.save')}</ion-button>
        <ion-button size="small" fill="outline" data-testid="tasks-project-toggle-active" ?disabled=${this.detailBusy}
          @click=${() => this.toggleActive()}>${active ? t('ui.actionDeactivate') : t('ui.actionActivate')}</ion-button>
      </form>
      ${this.detailError ? html`<p class="err" data-testid="tasks-project-detail-error">${this.detailError}</p>` : nothing}
      <h4>${t('ui.projectTasksHeading', { count: this.projectTasksTotal })}</h4>
      ${this.renderProjectTasks()}
      <form class="add-task" @submit=${(e: Event) => this.addTask(e)}>
        <ion-input mode="md" fill="outline" label-placement="floating" label=${t('ui.actionAddTask')} placeholder=${t('ui.newTaskPlaceholder')} .value=${this.newTaskTitle}
          @ionInput=${(e: any) => (this.newTaskTitle = e.target.value ?? '')}></ion-input>
        <ion-button type="submit" size="small" data-testid="tasks-project-add-task" ?disabled=${this.detailBusy || !this.newTaskTitle.trim()}>${t('ui.actionAddTask')}</ion-button>
      </form>
    </section>`;
  }

  /** pm#513: the refusal appears above the button that was pressed — on a phone that can leave it
   *  off the sheet. Bring it into view when it appears, not again on every keystroke. */
  updated(changed: PropertyValues): void {
    super.updated(changed);
    if (changed.has('formError') && this.formError) {
      this.renderRoot.querySelector('[data-testid="tasks-projects-form-error"]')?.scrollIntoView?.({ block: 'center' });
    }
  }

  render() {
    return html`<div class="page">
        ${this.ctrl?.error ? html`<p class="err">${this.ctrl.error}</p>` : nothing}
        ${this.renderDetail()}
        <ok-data-table .serverSide=${true} .fill=${true} .addable=${true} .views=${true} .cardTitle=${(row: Record<string, unknown>) => String(row.name ?? row.code ?? '—')} .columns=${this.columns} .rows=${this.ctrl?.rows ?? []} .total=${this.ctrl?.total ?? 0} .page=${this.ctrl?.state.page ?? 0} .pageSize=${this.ctrl?.state.pageSize ?? 50} .sort=${this.ctrl?.state.sort} .sortDir=${this.ctrl?.state.dir ?? 'desc'} .searchable=${true} .searchPlaceholder=${t('ui.searchProjectsPlaceholder')} .actions=${this.rowActions} .rowClickable=${true} .emptyMessage=${this.ctrl?.loading ? t('ui.loading') : t('ui.emptyProjects')} @pageChange=${(e: CustomEvent<number>) => this.ctrl.setPage(e.detail)} @sortChange=${(e: CustomEvent<{ sort: string; dir: 'asc' | 'desc' }>) => this.ctrl.setSort(e.detail.sort, e.detail.dir)} @searchChange=${(e: CustomEvent<string>) => this.ctrl.setSearch(e.detail)} @filterChange=${(e: CustomEvent<{ col: string; value: unknown }>) => this.ctrl.setFilter(e.detail.col, e.detail.value)} @rowClick=${(e: CustomEvent<{ row: Record<string, unknown> }>) => this.openProject(e.detail.row)} @rowAction=${(e: CustomEvent<{ actionId: string; row: Record<string, unknown> }>) => { if (e.detail.actionId === 'open') this.openProject(e.detail.row); }}>
          <!-- El formulario se proyecta SIEMPRE en el panel: si solo se pintara al abrirlo, el «+»
               abriría un panel vacío (la tabla no re-renderiza a sus hijos de luz). -->
          <form slot="create" class="form" @submit=${(e: Event) => this.createProject(e)}>
            <ion-input mode="md" fill="outline" label-placement="floating" label=${t('ui.colCode')} placeholder=${t('ui.codePlaceholder')} .value=${this.newCode} @ionInput=${(e: any) => (this.newCode = e.target.value)}></ion-input>
            <ion-input mode="md" fill="outline" label-placement="floating" label=${t('ui.colName')} .value=${this.newName} @ionInput=${(e: any) => (this.newName = e.target.value)}></ion-input>
            <ion-input mode="md" fill="outline" label-placement="floating" label=${t('ui.colColor')} placeholder=${t('ui.colorPlaceholder')} .value=${this.newColor} @ionInput=${(e: any) => (this.newColor = e.target.value)}></ion-input>
            <!-- pm#513: the refusal travels WITH the form — under 834 px the panel is a full-screen
                 sheet and a line on the page underneath it is never seen. -->
            ${this.formError ? html`<p class="err" data-testid="tasks-projects-form-error">${this.formError}</p>` : nothing}
            <ion-button type="submit" size="small" ?disabled=${this.saving || !this.newCode || !this.newName}>${this.saving ? t('ui.saving') : t('ui.add')}</ion-button>
          </form>
        </ok-data-table>
      </div>`;
  }
}

define('erp-tasks-projects', ErpTasksProjects);
