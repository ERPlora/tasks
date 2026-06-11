-- Marca la tarea como done y sella completed_at. Intención emitida por el handler
-- WASM (complete_task). Runtime inyecta :hub_id, :current_user_id, :now.
-- Guardas already_done / cancelled_locked en el WHERE (runtime sin lecturas
-- pre-cargadas): si la tarea ya está done o cancelled, el UPDATE es un no-op.
UPDATE tasks_task
SET status       = 'done',
    completed_at = :now,
    updated_by   = :current_user_id,
    updated_at   = :now
WHERE id = :task_id AND hub_id = :hub_id AND is_deleted = 0
  AND status NOT IN ('done', 'cancelled');
