-- Migration 001: Add RPC function to insert data from Shelly directly via MAC address and auto-register devices

CREATE OR REPLACE FUNCTION insert_reading_by_mac(
    p_mac_address VARCHAR,
    p_interval_start TIMESTAMP WITH TIME ZONE,
    p_energy_l1_kwh NUMERIC,
    p_energy_l2_kwh NUMERIC,
    p_energy_l3_kwh NUMERIC
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

    -- Insert or update the reading
    INSERT INTO readings (device_id, interval_start, energy_l1_kwh, energy_l2_kwh, energy_l3_kwh)
    VALUES (v_device_id, p_interval_start, p_energy_l1_kwh, p_energy_l2_kwh, p_energy_l3_kwh)
    ON CONFLICT (device_id, interval_start) DO UPDATE SET
        energy_l1_kwh = EXCLUDED.energy_l1_kwh,
        energy_l2_kwh = EXCLUDED.energy_l2_kwh,
        energy_l3_kwh = EXCLUDED.energy_l3_kwh;
END;
$$ LANGUAGE plpgsql;
