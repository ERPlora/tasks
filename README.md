# Módulo `tasks` — tareas internas y proyectos

Lista de trabajo **del equipo**: tareas con título, prioridad, asignado y vencimiento, agrupadas en
**proyectos**, anidables como **subtareas** y con hilo de **comentarios**.

> ⚠️ **No es `tickets`.** Aquello es el helpdesk (problema de un **cliente**, con SLA y respuestas
> públicas/internas); esto es la to-do interna. Si lleva SLA o lo va a leer el cliente, es un ticket.

<!-- -->

> **Module id:** `tasks`. **Depende de:** nada — y nada depende de él (`events.listen` declarado pero
> **vacío**). Módulo híbrido: SQL + handler WASM (`create_task`, `update_status`, `complete_task`).
> ❄️ **Congelado**: su doc de arquitectura vive en `architecture/_frozen/modules/tasks.md`.

## Documentación de usuario — [`docs/`](docs/)

Viaja **dentro** del módulo y se versiona con él: el asistente del hub (ADR-0282) la indexa por
versión instalada y cita la de TU versión, no la de la última publicada. En inglés (idioma fuente).

| Fichero | Para qué |
| ------- | -------- |
| [`docs/overview.md`](docs/overview.md) | Qué hace y qué NO hace; el vocabulario y la numeración |
| [`docs/screens.md`](docs/screens.md) | Tasks y Projects: crear, asignar, cambiar estado, completar, comentar |
| [`docs/concepts.md`](docs/concepts.md) | Tareas ≠ tickets, **los 3 roles tienen los MISMOS permisos**, `completed_at` se gestiona solo, `cancelled` ≠ `done`, borrar proyecto ≠ borrar tarea padre |
| [`docs/limits.md`](docs/limits.md) | Los 4 errores y los 3 **no-op mudos**, valores aceptados y diagnóstico |

## Permisos: sin escalones

`admin`, `manager` y `employee` tienen **los tres permisos** (`view_task`, `add_task`,
`manage_task`). Es inusual en este producto y es a propósito: una lista de tareas que nadie puede
editar no sirve para nada.

## Qué expone hoy

| Tipo | Nombre | Permiso |
| ---- | ------ | ------- |
| query | `tasks.tasks.list` / `.get` / `.subtasks` / `.comments` / `.my` · `tasks.projects.list` | `view_task` |
| command | `tasks.tasks.create` (WASM) · `.add_comment` · `tasks.projects.create` | `add_task` |
| command | `tasks.tasks.update_status` (WASM) / `.complete` (WASM) / `.assign` | `manage_task` |
| emite | `tasks.task.created` / `.status_changed` / `.completed` (⚠️ **del handler**, no del manifest), `tasks.task.assigned`, `tasks.comment.added`, `tasks.project.created` | — |
| escucha | — (bloque declarado y **vacío**) | — |

Navegación: `erp-tasks-list` («Tasks») y `erp-tasks-projects` («Projects»).

## Layout

```text
module.json                   # manifest (contrato técnico)
migrations/                   # esquema §2.5 + contador atómico por (hub_id, day)
queries/*.sql                 # lecturas declarativas (:hub_id inyectado)
commands/*.sql                # escrituras declarativas (las `_` son intenciones del WASM)
schemas/*.json                # JSON Schemas de input (draft 2020-12)
handler/                      # WASM Tier 2 → dist/handler.wasm
ui/                           # Web Components (Lit/Ionic/OutfitKit)
docs/                         # documentación de usuario + corpus del asistente
```

## Estado y trabajo abierto

Módulo **congelado**. Limitaciones documentadas en `docs/limits.md`: **cero notificaciones**, cero
tareas programadas, sin control de tiempo ni adjuntos, sin integración con `staff` (las personas son
referencias laxas) y varias guardas que fallan como **no-op mudo**.

Doc de arquitectura: `architecture/_frozen/modules/tasks.md`.
