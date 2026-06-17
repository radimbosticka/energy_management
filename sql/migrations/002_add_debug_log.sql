-- Migration 002: Add table and RPC function for debugging Shelly device connectivity

CREATE TABLE device_debug_logs (
    id BIGSERIAL PRIMARY KEY,
    mac_address VARCHAR(17) NOT NULL,
    message TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION insert_debug_log(
    p_mac_address VARCHAR,
    p_message TEXT
) RETURNS VOID AS $$
BEGIN
    INSERT INTO device_debug_logs (mac_address, message)
    VALUES (p_mac_address, p_message);
END;
$$ LANGUAGE plpgsql;
