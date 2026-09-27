# Tasks — Limits and troubleshooting

## Known limitations you should know about

- **No notifications of any kind.** Nothing is sent when a task is assigned, due or overdue.
- **No scheduled tasks.** Nothing chases anything.
- **Several failures are silent no-ops.** Completing an already-done or cancelled task, and acting on
  a task that does not exist, change nothing and report nothing.
- **No time tracking, estimates or reporting.**
- **No attachments.**
- **No link to staff or user records.** Every person is a loose reference.

## Errors and refusals

These are returned as errors, with **nothing written**:

| Error | What happened | What to do |
|---|---|---|
| `missing_title` | The task has no title | Give it one |
| `invalid_priority` | The priority is not one of the four | Use `low`, `medium`, `high` or `urgent` |
| `invalid_due_date` | The due date could not be parsed | Use `YYYY-MM-DD` or a valid datetime |
| `invalid_status` | The target status is not one of the five | Use a valid status |

These fail as **no-ops**, with no message:

| Situation | Result |
|---|---|
| The project or the parent task does not exist in this hub | The task is not created |
| Completing a task that is already `done` or `cancelled` | Nothing changes |
| Changing the status of a task that does not exist | Nothing changes |

## Required fields

| Action | Must provide |
|---|---|
| Create a task | `title` |
| Change the status | `task_id`, `new_status` |
| Complete | `task_id` |
| Assign | `task_id` |
| Add a comment | `task_id`, **`comment`** (non-empty) |
| Create a project | `code`, `name` |
| List my tasks | `assigned_to_ref` |

## Accepted values

| Field | Values |
|---|---|
| Status | `todo`, `in_progress`, `blocked`, `done`, `cancelled` (default `todo`) |
| Priority | `low`, `medium`, `high`, `urgent` (default `medium`) |
| Due date | `YYYY-MM-DD`, a datetime with an offset, or one without — read as **UTC** |
| Tags | a free list, empty by default |

## Caps and sizes

| Limit | Value |
|---|---|
| Rows per page (tasks, projects) | 50 |
| Maximum rows a paginated request may ask for | 500 |
| Tasks per day per hub, by numbering | 9999 |
| Project codes | unique per hub |
| Task numbers | unique per hub |

## Permissions per action

| To do this | You need |
|---|---|
| See tasks, subtasks, comments and projects | `tasks.view_task` |
| Create a task, add a comment, create a project | `tasks.add_task` |
| Assign, change status, complete | `tasks.manage_task` |

**All three roles — admin, manager and employee — have all three permissions.** There is no
restricted tier in this module.

## Dependencies

**None in either direction.** Tasks depends on no module, no module depends on it, and its listener
block is empty.

Two consequences worth stating:

- **It does not integrate with `staff`.** The assignee is picked from the hub's active people
  (`hub.users.list`, the core), not from `staff`, and the command does not validate that the person
  still exists.
- **Its events are published but nobody listens.** Anything reacting to a task would have to declare
  the listener on its own side.

## When something looks wrong

**"I created a task and it did not appear."** The **project** or the **parent task** you pointed at
does not exist in this hub. That check happens inside the write and fails silently.

**"Completing a task did nothing."** It was already `done` or `cancelled`. Both are refused as
no-ops.

**"The completion date is wrong or missing."** You never set it directly — it is stamped when the
status moves to `done` and cleared when it moves back out. If it is missing, the task was probably
marked done by some other route.

**"A cancelled task cannot be completed."** Correct, and deliberate. Change its status explicitly
first if it really is finished.

**"The due date shifted by a couple of hours."** A datetime with no offset is read as **UTC**, not
local time.

**"My listener never sees a creation event."** `tasks.task.created`, `.status_changed` and
`.completed` come from the handler and are not declared in the manifest. They exist.

**"Nobody was told they were assigned."** Nothing notifies. There is no email, no push and no
reminder anywhere in this module.

**"An employee changed a task I own."** Expected — all three roles have the same permissions here.

**"I deleted a project and lost the tasks."** You did not: tasks survive and lose the project.
Deleting a **parent task**, on the other hand, does remove its subtasks.

**"Two tasks share a number."** They cannot; the counter is atomic per hub and day.
