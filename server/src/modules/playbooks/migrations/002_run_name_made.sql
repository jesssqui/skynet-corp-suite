-- D9 review: a run keeps its playbook's name as it was (later months' notes use it, even after the playbook
-- is renamed or deleted) and what it made in the client's records (`made`: "relationship:<id> service:<id>
-- restarted:relationship:<id> renewal:<service id>:<old date>"), so the extra of a run made twice can be
-- taken back. Schema only (sync rule 6).
ALTER TABLE playbooks_runs ADD COLUMN playbook_name TEXT;
ALTER TABLE playbooks_runs ADD COLUMN made TEXT;
