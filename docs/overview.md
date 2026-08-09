# Tasks — Overview

## What this module does

Tasks is the internal to-do list of the business. It records work items with a title, a priority, an
assignee and a due date; groups them into **projects**; nests them as **subtasks**; and keeps a
comment thread on each one.

It is for **your team**, not for customers.

## What this module does NOT do

- **It does not track customer issues.** That is `tickets`, the helpdesk, which has SLAs and a
  customer on it.
- **It does not link to staff records or user accounts.** Assignee, creator, owner and comment author
  are loose text references with no foreign key.
- **It does not notify anybody.** No email, no push, no reminder — not on assignment, not when a task
  is overdue.
- **It does not track time**, estimate effort or report on velocity.
- **It does not run anything on a schedule.** Nothing chases an overdue task.
- **It does not attach files.**

## Modules it connects to

**Depends on nothing**, and nothing depends on it. Its event listener block exists but is empty.

**Events it emits**

| Event | When |
|---|---|
| `tasks.task.created` | a task is created |
| `tasks.task.status_changed` | its status changes |
| `tasks.task.completed` | it is completed |
| `tasks.task.assigned` | it is assigned or reassigned |
| `tasks.comment.added` | a comment is added |
| `tasks.project.created` | a project is created |

The first three are emitted **by the handler** and are not declared in the manifest — searching
`module.json` for them finds nothing.

**Events it listens to** — none.

## The vocabulary

| Concept | Values |
|---|---|
| **Status** | `todo`, `in_progress`, `blocked`, `done`, `cancelled` — default `todo` |
| **Priority** | `low`, `medium`, `high`, `urgent` — default `medium` |
| **Project** | A named bucket with a unique code, an owner and a colour |
| **Subtask** | A task whose parent is another task |
| **Tags** | A free list on the task |

## Task numbering

Tasks are numbered `TSK-YYYYMMDD-NNNN`, unique per hub, allocated from an atomic per-day counter in
the same transaction that creates the task.

## Everyone can use it

Unusually for this product, **admin, manager and employee have exactly the same three permissions**.
Anybody on the team can create a task, assign it, change its status and comment.
