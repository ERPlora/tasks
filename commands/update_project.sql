-- Edits a project's name, colour and «active» flag (tasks#43). Runtime injects :hub_id,
-- :current_user_id, :now. The code is the project's key and is never rewritten here.
-- An unknown id, another hub's project or a soft-deleted one match nothing: 0 rows, and the
-- manifest's expect_rows turns that into tasks.project_not_found with no event.
UPDATE tasks_project
SET name       = :name,
    color      = :color,
    is_active  = :is_active,
    updated_by = :current_user_id,
    updated_at = :now
WHERE id = :project_id AND hub_id = :hub_id AND is_deleted = 0;
