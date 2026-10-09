-- D2 (matching): why a link was made, shown beside it ("Linked automatically (same email)"). A new
-- nullable column of a synced table: no rows are written here (sync rule 6) — only links made from
-- now on carry a reason (auto links: "same email" / "same phone"; approved ones the suggestion's reason).
ALTER TABLE crm_links ADD COLUMN match_reason TEXT;
