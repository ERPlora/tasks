# Tasks — Screens

The module contributes two tabs to the hub navigation: **Tasks** and **Projects**.

## Tasks

Every task in the hub with its status, priority and assignee (`tasks.tasks.list`, 50 rows per page).
Newest first. Requires `tasks.view_task`.

- **Search** by task number, title, description, assignee or creator.
- **Filter** by task number, title, description, project, status, priority, assignee, creator, parent
  task or tags; and by range on the due date, the completion date or the creation date.

Open a task for its full detail (`tasks.tasks.get`), its **subtasks**
(`tasks.tasks.subtasks`) and its **comment thread** (`tasks.tasks.comments`).

### See only your own work

`tasks.tasks.my` lists the tasks assigned to a given person. It takes the assignee reference and
returns their tasks — the "what am I supposed to be doing" view.

### Create a task

1. Give the **title** — it is the only required field.
2. Optionally set the description, the **priority** (`low`, `medium`, `high`, `urgent`), the
   **assignee**, the **due date**, the **project**, a **parent task** and **tags**.
3. Save.

The task is created `todo` with no completion date, and gets its number `TSK-YYYYMMDD-NNNN`.

The due date accepts a plain `YYYY-MM-DD`, a datetime with an offset, or a datetime with none — the
last is read as UTC.

Requires `tasks.add_task` — an employee has it.

### Assign or reassign

Set the assignee. Requires `tasks.manage_task`, which an employee also has.

### Change the status

Pick one of `todo`, `in_progress`, `blocked`, `done` or `cancelled`.

The completion date is handled for you: moving **to** `done` stamps it, and **reopening from**
`done` clears it. Any other transition leaves it alone. Requires `tasks.manage_task`.

### Complete a task

A shortcut that sets the status to `done` and stamps the completion date.

It is refused — as a silent no-op — if the task is already `done` or `cancelled`. Requires
`tasks.manage_task`.

### Comment on a task

Give the task and the comment text; both are required. The comment joins the thread with its author.
Requires `tasks.add_task`.

## Projects

Buckets that group related tasks (`tasks.projects.list`, 50 rows per page). Requires
`tasks.view_task`.

### Create a project

1. Give the **code** and the **name** — both required. The code is unique in the hub.
2. Optionally set the owner and a colour.

Requires `tasks.add_task`.

Deleting a project does not delete its tasks; they simply lose the project.

## Subtasks

A task can have a **parent task**, which is how a checklist under a bigger item is expressed. Both
the project and the parent must exist and be alive in this hub, or the task is not created.

Unlike a project, deleting a parent task **takes its subtasks with it**.
