import { LitElement, html, css, nothing } from 'lit';
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
  `;

  @state() newCode = '';

  @state() newName = '';

  @state() newColor = '';

  @state() saving = false;

  @state() formError = '';

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

  // Re-render al cambiar el idioma del shell (ADR-0055): el getter `columns` y el texto del
  // template se re-evalúan con el nuevo `erplora.locale`.
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
      const off = erplora().on('tasks.project.created', () => this.ctrl.load());
      this.unsub = () => off();
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

  render() {
    return html`<div class="page">
        ${this.formError ? html`<p class="err">${this.formError}</p>` : nothing}
        ${this.ctrl?.error ? html`<p class="err">${this.ctrl.error}</p>` : nothing}
        <ok-data-table .serverSide=${true} .fill=${true} .addable=${true} .columns=${this.columns} .rows=${this.ctrl?.rows ?? []} .total=${this.ctrl?.total ?? 0} .page=${this.ctrl?.state.page ?? 0} .pageSize=${this.ctrl?.state.pageSize ?? 50} .sort=${this.ctrl?.state.sort} .sortDir=${this.ctrl?.state.dir ?? 'desc'} .searchable=${true} .searchPlaceholder=${t('ui.searchProjectsPlaceholder')} .emptyMessage=${this.ctrl?.loading ? t('ui.loading') : t('ui.emptyProjects')} @pageChange=${(e: CustomEvent<number>) => this.ctrl.setPage(e.detail)} @sortChange=${(e: CustomEvent<{ sort: string; dir: 'asc' | 'desc' }>) => this.ctrl.setSort(e.detail.sort, e.detail.dir)} @searchChange=${(e: CustomEvent<string>) => this.ctrl.setSearch(e.detail)} @filterChange=${(e: CustomEvent<{ col: string; value: unknown }>) => this.ctrl.setFilter(e.detail.col, e.detail.value)}>
          <!-- El formulario se proyecta SIEMPRE en el panel: si solo se pintara al abrirlo, el «+»
               abriría un panel vacío (la tabla no re-renderiza a sus hijos de luz). -->
          <form slot="create" class="form" @submit=${(e: Event) => this.createProject(e)}>
            <ion-input fill="outline" label-placement="floating" label=${t('ui.colCode')} placeholder=${t('ui.codePlaceholder')} .value=${this.newCode} @ionInput=${(e: any) => (this.newCode = e.target.value)}></ion-input>
            <ion-input fill="outline" label-placement="floating" label=${t('ui.colName')} .value=${this.newName} @ionInput=${(e: any) => (this.newName = e.target.value)}></ion-input>
            <ion-input fill="outline" label-placement="floating" label=${t('ui.colColor')} placeholder=${t('ui.colorPlaceholder')} .value=${this.newColor} @ionInput=${(e: any) => (this.newColor = e.target.value)}></ion-input>
            <ion-button type="submit" size="small" ?disabled=${this.saving || !this.newCode || !this.newName}>${this.saving ? t('ui.saving') : t('ui.add')}</ion-button>
          </form>
        </ok-data-table>
      </div>`;
  }
}

define('erp-tasks-projects', ErpTasksProjects);
