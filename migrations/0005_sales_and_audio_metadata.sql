ALTER TABLE leads ADD COLUMN role TEXT;
ALTER TABLE leads ADD COLUMN current_process TEXT;
ALTER TABLE leads ADD COLUMN main_pain TEXT;
ALTER TABLE leads ADD COLUMN desired_outcome TEXT;
ALTER TABLE leads ADD COLUMN volume TEXT;
ALTER TABLE leads ADD COLUMN meeting_interest INTEGER;
ALTER TABLE leads ADD COLUMN preferred_meeting_date TEXT;
ALTER TABLE leads ADD COLUMN preferred_meeting_time TEXT;

ALTER TABLE messages ADD COLUMN source_type TEXT DEFAULT 'text';
ALTER TABLE messages ADD COLUMN transcription_provider TEXT;
ALTER TABLE messages ADD COLUMN transcription_model TEXT;
ALTER TABLE messages ADD COLUMN transcription_status TEXT;
