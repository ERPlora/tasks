# WORKFLOW — Tareas

Prefijo: TASKS
Alcance MVP: congelado

## Para qué sirve y para quién
Lista de tareas internas del equipo: tareas con responsable, prioridad y fecha límite, agrupadas en proyectos, con subtareas y comentarios. Es para el personal, no para clientes. Módulo congelado: su comportamiento no se cambia. Una issue que pida cambiarlo se contesta FUERA DE WORKFLOW; solo se admiten arreglos de seguridad, de dinero o de datos de otro negocio.

## Qué hay hoy
- Pantalla «Tasks»: lista, crear tarea (número `TSK-AAAAMMDD-NNNN`), cambiar estado (por hacer, en curso, bloqueada, hecha, cancelada), completar, asignar, comentar, ver subtareas y «mis tareas».
- Pantalla «Projects»: crear y editar proyectos (nombre, color, activo).
- Crear una tarea con un proyecto o tarea padre que no existe contesta bien, no crea nada, gasta un número `TSK-` y emite `tasks.task.created` (la orden interna no lleva compuerta de filas y el manejador no lo comprueba). Importa porque las automatizaciones usan `tasks.tasks.create` como paso.
- El autor de un comentario (`author_ref`) y el creador de la tarea (`created_by_ref`) se toman del payload si vienen: se puede firmar como otra persona. Queda la auditoría `created_by`.
- Permisos: `view_task`, `add_task`, `manage_task`; empleado y encargado tienen los tres.

## A quién toca
- **A nadie.** `depends_on: []`, `events.listen: {}`, sin ranuras en pantallas ajenas; ningún otro módulo lo nombra salvo `flows` (una plantilla de ejemplo y el asistente pueden ejecutar `tasks.tasks.create` como acción de una automatización autorizada). Instalarlo no cambia ventas, caja, clientes ni citas.
- Emite `tasks.task.{created,status_changed,completed,assigned}`, `tasks.comment.added`, `tasks.project.{created,updated}`; ningún módulo los escucha. Los tres primeros los emite el manejador (están en `events.emits` pero la orden no lleva `emit`).
- Automatizaciones (`flows`, FLOWS-F13 «Elegir cuándo arranca») ofrece como disparador todo aviso que declare un módulo instalado: todos sus avisos pueden arrancar una automatización y `tasks.task.completed` tiene frase propia. Un `tasks.task.created` puede salir sin tarea (alta con proyecto inexistente).

- Con el módulo instalado, el asistente gana sus consultas y órdenes como herramientas, sin etiqueta de orden en `locales/es.json` (la tarjeta de confirmación dice «Una acción que esta app no sabe nombrar») y sin `ai.risk` (sin confirmación reforzada).  Riesgo sin confirmar (haría falta ejecutar el asistente).
- Pendiente de enlazar: flows — FLOWS-F13 (Elegir cuándo arranca): `tasks.task.created` puede salir en falso (alta con proyecto o padre inexistente) y arrancar una automatización sin tarea.
- Responsable, autor y creador son referencias de texto a personas del hub, sin vínculo a clientes ni a `staff`.

## Lo que NO hace, a propósito
- No avisa a nadie (ni correo, ni push, ni recordatorio de vencimiento).
- No registra tiempo, estimaciones ni informes.
- No corre nada programado ni persigue tareas vencidas.
- No adjunta ficheros.
- No gestiona incidencias de clientes (eso es `tickets`).
