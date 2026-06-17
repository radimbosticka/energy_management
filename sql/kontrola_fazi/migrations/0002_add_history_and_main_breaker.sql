ALTER TABLE phase_overload_events 
ADD COLUMN local_load_history_10m JSONB,
ADD COLUMN is_main_breaker BOOLEAN DEFAULT false;
