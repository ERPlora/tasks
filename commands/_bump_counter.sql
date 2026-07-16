-- PG-compat (auditoría pm#16, 07-17): columna CUALIFICADA en DO UPDATE — sin cualificar
-- es AMBIGUA en Postgres (error de parseo; SQLite lo tolera). Mismo bug que mató la agenda
-- de appointments en Hub Cloud (appointments#19).
-- Incrementa atómicamente el contador de tareas del día (upsert). Primera intención
-- de create_task. Runtime inyecta :new_id, :hub_id, :current_user_id, :now;
-- :day (YYYYMMDD) lo aporta el handler WASM. Mismo patrón que sales._bump_counter.
INSERT INTO tasks_counter (
    id, hub_id, day, last_number, is_deleted, created_by, updated_by, created_at, updated_at
)
VALUES (:new_id, :hub_id, :day, 1, 0, :current_user_id, :current_user_id, :now, :now)
ON CONFLICT (hub_id, day) DO UPDATE
SET last_number = tasks_counter.last_number + 1,
    updated_by  = :current_user_id,
    updated_at  = :now;
