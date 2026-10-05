# WORKFLOW — Tareas

Prefijo: TASKS
Alcance MVP: congelado

## Para qué sirve y para quién
Lista de tareas internas del equipo: tareas con responsable, prioridad y fecha límite, agrupadas en proyectos, con subtareas y comentarios. Es para el personal, no para clientes. Módulo congelado: su comportamiento no se cambia. Una issue que pida cambiarlo se contesta FUERA DE WORKFLOW; solo se admiten arreglos de seguridad, de dinero o de datos de otro negocio.

## Qué hay hoy
- Pantalla «Tasks»: lista, crear tarea (número `TSK-AAAAMMDD-NNNN`), cambiar estado (por hacer, en curso, bloqueada, hecha, cancelada), completar, asignar, comentar, ver subtareas y «mis tareas».
- Pantalla «Projects»: crear y editar proyectos (nombre, color, activo).
- Permisos: `view_task`, `add_task`, `manage_task`; empleado y encargado tienen los tres.

## A quién toca
- **A nadie.** `depends_on: []`, `events.listen: {}`, sin ranuras en pantallas ajenas; ningún otro módulo lo nombra salvo `flows` (una plantilla de ejemplo y el asistente pueden ejecutar `tasks.tasks.create` como acción de una automatización autorizada). Instalarlo no cambia ventas, caja, clientes ni citas.
- Emite `tasks.task.{created,status_changed,completed,assigned}`, `tasks.comment.added`, `tasks.project.{created,updated}`; nadie los escucha. Los tres primeros salen del handler y no están declarados en el manifiesto.
- Responsable, autor y creador son referencias de texto a personas del hub, sin vínculo a clientes ni a `staff`.

## Lo que NO hace, a propósito
- No avisa a nadie (ni correo, ni push, ni recordatorio de vencimiento).
- No registra tiempo, estimaciones ni informes.
- No corre nada programado ni persigue tareas vencidas.
- No adjunta ficheros.
- No gestiona incidencias de clientes (eso es `tickets`).
