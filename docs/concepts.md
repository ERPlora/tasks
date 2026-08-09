# Tasks — Concepts

The things people get wrong on their first day.

## Tasks are internal; tickets are for customers

Two modules look like issue trackers and they are not interchangeable:

| | **Tasks** | **Tickets** |
|---|---|---|
| About | Your team's own work | A **customer's** problem |
| Has | Projects, subtasks, priority | SLA targets, public/internal replies, a customer |
| Measures | Nothing | Response and resolution time |

If it needs an SLA or the customer will read the reply, it is a ticket, not a task.

## Everybody has the same permissions

This module has three permissions and **admin, manager and employee all have all three**. There is no
privileged tier: an employee can create, assign, change status and comment exactly like an admin.

That is unusual in this product and it is deliberate — a team to-do list nobody can edit is useless.

## The completion date manages itself

You never set it. Changing a task's status handles it:

- moving **to `done`** stamps the completion date;
- **reopening from `done`** clears it;
- every other transition leaves it untouched.

That is why the status is the thing to change, not the date.

## `complete` is a shortcut, and it refuses silently

Completing sets `done` and stamps the date. It is refused when the task is already `done` or
`cancelled` — but the refusal is a **no-op**: nothing changes and nothing tells you.

The same is true of a status change on a task that does not exist. **Re-read the task after acting.**

## `cancelled` is not `done`

A cancelled task will not be completed and does not count as finished. The completion shortcut
deliberately refuses to touch it, so you cannot accidentally "finish" work that was called off.

You can still move it out of `cancelled` with an explicit status change.

## The project and the parent must exist, or the task is not created

Both references are checked inside the write itself. A task pointing at a project or a parent that
does not exist — or that belongs to another hub — is simply not created.

If a task you created did not appear, this is almost always why.

## A project and a parent task behave differently on deletion

- **Deleting a project** leaves its tasks alone; they lose the project and carry on.
- **Deleting a parent task takes its subtasks with it.**

Worth knowing before you clean up.

## People are loose text, not accounts

Assignee, creator, project owner and comment author are all stored as plain references **without a
foreign key** to any user or staff module.

So renaming or deactivating a person elsewhere does not update old tasks, you cannot navigate from a
task to a staff record, and "my tasks" is a match on that reference, not on a logged-in identity.

## Due dates are normalised to UTC

The due date accepts three shapes: a plain `YYYY-MM-DD`, a datetime with an offset, and a datetime
without one. **A datetime with no offset is read as UTC**, not as local time.

If a due date looks shifted by a couple of hours, that is why.

## Numbering is per day and atomic

`TSK-YYYYMMDD-NNNN`, unique per hub, from a counter bumped in the same transaction as the insert. Two
people creating a task at the same second cannot collide, and the sequence restarts each day.

## Comments accumulate

The thread is a record. There is no command to edit or delete a comment, and a comment cannot be
empty.

## Three events come from the handler, not the manifest

`tasks.task.created`, `tasks.task.status_changed` and `tasks.task.completed` are emitted by the
engine. They are not in the manifest's declared emits, so grepping for them finds nothing and you
would wrongly conclude they do not exist.

## Nothing chases anybody

There is no scheduled task, no notification and no reminder. An overdue task stays overdue quietly
until somebody looks at the list.

## Deleting is a soft delete

Tasks, projects and comments are marked deleted, never erased.
