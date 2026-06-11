-- Incrementa atómicamente el contador de tareas del día (upsert). Primera intención
-- de create_task. Runtime inyecta :new_id, :hub_id, :current_user_id, :now;
-- :day (YYYYMMDD) lo aporta el handler WASM. Mismo patrón que sales._bump_counter.
INSERT INTO tasks_counter (
    id, hub_id, day, last_number, is_deleted, created_by, updated_by, created_at, updated_at
)
VALUES (:new_id, :hub_id, :day, 1, 0, :current_user_id, :current_user_id, :now, :now)
ON CONFLICT (hub_id, day) DO UPDATE
SET last_number = last_number + 1,
    updated_by  = :current_user_id,
    updated_at  = :now;
