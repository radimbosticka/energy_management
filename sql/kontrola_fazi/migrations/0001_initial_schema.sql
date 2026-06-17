CREATE TABLE IF NOT EXISTS phase_overload_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at TIMESTAMPTZ DEFAULT now(),
    trigger_device_name TEXT,
    threshold_limit NUMERIC,
    breached_values JSONB,
    measurements JSONB
);

-- Enable Row Level Security
ALTER TABLE phase_overload_events ENABLE ROW LEVEL SECURITY;

-- Create policy to allow inserts only from the service role (Edge Function)
CREATE POLICY "Allow service role to insert" ON phase_overload_events
    FOR INSERT
    TO service_role
    WITH CHECK (true);
