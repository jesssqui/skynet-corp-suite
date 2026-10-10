-- Leads and the pipeline (D8): a task may name the lead it is the next step for (a plain ref to the
-- crm's `lead`: deleting a lead never hides its tasks). Schema only — no rows are written here
-- (CLAUDE.md, sync rule 6); old devices' steps without it still apply.
ALTER TABLE planner_tasks ADD COLUMN lead_id TEXT;
CREATE INDEX planner_tasks_lead ON planner_tasks (lead_id);
