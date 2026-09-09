# Tasks snapshot accepted work and survive their sources

A Task is an independently editable snapshot of accepted work, not an editable Meeting Debrief field. It is open or completed, may be reopened, belongs to exactly one Task List, and may name a Responsible Person without making that person an app user. Inbox is the default Task List; separate Projects, tags, subtasks, recurrence, reminders, attachments, dependencies, comments and time estimates are outside the first version.

The first Task record carries a title, notes, optional due date, Task Priority, Responsible Person, source reference, current state, and created, updated, completed and deleted timestamps. Dates have no time and use the Workspace time zone. Task Priority is none, low, medium or high and stays local because the external task systems have no shared priority contract.

Promoting an Action Item records the new Task on that Action Item, but later Task edits never change the Meeting Debrief and regeneration never changes or deletes the Task. A Task survives deletion of its Meeting, Meeting Debrief or Transcript and survives Clear generated data; a missing source is reported rather than cascading deletion. Task deletion uses recoverable Trash, with explicit confirmation required for permanent deletion.
