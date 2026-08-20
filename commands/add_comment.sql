-- Añade un comentario a una tarea. Runtime inyecta :new_id, :hub_id, :current_user_id, :now.
-- Portado de TaskService.add_comment. El comment no vacío lo valida el JSON Schema (minLength).
--
-- La existencia de la tarea se resuelve AQUÍ, en el WHERE del INSERT…SELECT, no en la FK
-- (tasks#24). La FK comprueba que la FILA existe, no de quién es: dejándole a ella el rechazo,
-- un task_id de OTRO hub —o de una tarea borrada— la satisfacía y el comentario se escribía,
-- cruzando de negocio. Y cuando sí rechazaba, lo hacía con el texto crudo del driver
-- («violates foreign key constraint … _fkey»), que no es un código estable para la UI.
--
-- Con esta forma, cualquiera de esos casos selecciona 0 filas y el `expect_rows` del manifiesto
-- lo convierte en 409 `tasks.task_not_found`. Mismo patrón que `customers.notes.add`.
INSERT INTO tasks_comment
  (id, hub_id, task_id, author_ref, comment,
   is_deleted, created_by, updated_by, created_at, updated_at)
SELECT :new_id, t.hub_id, t.id, :author_ref, :comment,
       0, :current_user_id, :current_user_id, :now, :now
FROM tasks_task t
WHERE t.id = :task_id AND t.hub_id = :hub_id AND t.is_deleted = 0;
