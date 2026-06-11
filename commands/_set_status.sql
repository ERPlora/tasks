-- Cambia el estado con sellado condicional de completed_at. Intención emitida por el
-- handler WASM (update_status). Runtime inyecta :hub_id, :current_user_id, :now.
-- El sellado depende del estado PREVIO, que lee el propio UPDATE (los CASE del SET
-- ven la fila vieja tanto en SQLite como en Postgres):
--   :new_status = 'done'                  → completed_at = :now
--   estado previo 'done' y nuevo distinto → completed_at = NULL (reapertura)
--   resto                                 → completed_at sin cambios
-- Tarea inexistente/borrada → no-op (runtime sin lecturas pre-cargadas).
UPDATE tasks_task
SET completed_at = CASE
        WHEN :new_status = 'done' THEN :now
        WHEN status = 'done' AND :new_status <> 'done' THEN NULL
        ELSE completed_at
    END,
    status     = :new_status,
    updated_by = :current_user_id,
    updated_at = :now
WHERE id = :task_id AND hub_id = :hub_id AND is_deleted = 0;
