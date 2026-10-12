-- Projects and playbooks (D9): a task may come from a playbook run — the run (`run_id`) and the run's own
-- copy of the step that made it (`run_step_id`), so a run's page lists its checklist by stage. Plain ids
-- with no ref (the planner doesn't depend on the later playbooks module; deleting a run never hides its
-- tasks). Schema only — no rows are written here (CLAUDE.md, sync rule 6); old devices' steps without
-- them still apply.
ALTER TABLE planner_tasks ADD COLUMN run_id TEXT;
ALTER TABLE planner_tasks ADD COLUMN run_step_id TEXT;
CREATE INDEX planner_tasks_run ON planner_tasks (run_id);
