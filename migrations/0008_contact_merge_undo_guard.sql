ALTER TABLE contact_merge_history ADD COLUMN IF NOT EXISTS references_after jsonb NOT NULL DEFAULT '{}';
