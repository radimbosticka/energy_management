-- Migration 004: Change interval_start to UNIX timestamp (BIGINT) for better IoT compatibility

-- Drop the old function
DROP FUNCTION IF EXISTS insert_reading_by_mac(VARCHAR, TIMESTAMP WITH TIME ZONE, NUMERIC, NUMERIC, NUMERIC);

-- Create the new function accepting BIGINT unix timestamp
CREATE OR REPLACE FUNCTION insert_reading_by_mac(
    p_mac_address VARCHAR,
    p_interval_start_ts BIGINT,
    p_energy_l1_kwh NUMERIC,
    p_energy_l2_kwh NUMERIC,
    p_energy_l3_kwh NUMERIC
) RETURNS VOID AS $$
DECLARE
    v_device_id UUID;
    v_interval_start TIMESTAMP WITH TIME ZONE;
BEGIN
    -- Convert unix epoch to timestamp with time zone
    v_interval_start := to_timestamp(p_interval_start_ts);
    
    -- Attempt to find the device
    SELECT id INTO v_device_id FROM devices WHERE mac_address = p_mac_address;
    
    -- If the device does not exist, auto-create it
    IF v_device_id IS NULL THEN
        INSERT INTO devices (mac_address, name) 
        VALUES (p_mac_address, 'Shelly ' || p_mac_address)
        RETURNING id INTO v_device_id;
    END IF;

    -- Insert or update the reading
    INSERT INTO readings (device_id, interval_start, energy_l1_kwh, energy_l2_kwh, energy_l3_kwh)
    VALUES (v_device_id, v_interval_start, p_energy_l1_kwh, p_energy_l2_kwh, p_energy_l3_kwh)
    ON CONFLICT (device_id, interval_start) DO UPDATE SET
        energy_l1_kwh = EXCLUDED.energy_l1_kwh,
        energy_l2_kwh = EXCLUDED.energy_l2_kwh,
        energy_l3_kwh = EXCLUDED.energy_l3_kwh;
END;
$$ LANGUAGE plpgsql;
