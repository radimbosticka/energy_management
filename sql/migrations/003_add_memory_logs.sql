-- Migration 003: Add memory tracking for Shelly devices

CREATE TABLE device_memory_logs (
    id BIGSERIAL PRIMARY KEY,
    device_id UUID NOT NULL REFERENCES devices(id),
    ram_free_bytes INTEGER NOT NULL,
    ram_total_bytes INTEGER NOT NULL,
    recorded_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Dedicated RPC function for memory logging
CREATE OR REPLACE FUNCTION insert_memory_log_by_mac(
    p_mac_address VARCHAR,
    p_ram_free INTEGER,
    p_ram_total INTEGER
) RETURNS VOID AS $$
DECLARE
    v_device_id UUID;
BEGIN
    -- Attempt to find the device
    SELECT id INTO v_device_id FROM devices WHERE mac_address = p_mac_address;
    
    -- If the device does not exist, auto-create it
    IF v_device_id IS NULL THEN
        INSERT INTO devices (mac_address, name) 
        VALUES (p_mac_address, 'Shelly ' || p_mac_address)
        RETURNING id INTO v_device_id;
    END IF;

    -- Insert into dedicated memory log table
    INSERT INTO device_memory_logs (device_id, ram_free_bytes, ram_total_bytes)
    VALUES (v_device_id, p_ram_free, p_ram_total);
END;
$$ LANGUAGE plpgsql;
