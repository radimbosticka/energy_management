-- PL/pgSQL function to calculate billing for a single 15-minute interval.

CREATE OR REPLACE FUNCTION process_interval_billing_3phase(p_interval_start TIMESTAMP WITH TIME ZONE)
RETURNS VOID AS $$
DECLARE
    -- Total house (from the perspective of the main grid meter)
    v_import_l1 NUMERIC; v_import_l2 NUMERIC; v_import_l3 NUMERIC;
    v_fve_l1 NUMERIC; v_fve_l2 NUMERIC; v_fve_l3 NUMERIC;
    
    -- Sum of internal Shelly circuits
    v_shelly_l1 NUMERIC; v_shelly_l2 NUMERIC; v_shelly_l3 NUMERIC;
    
    -- Previous state of the SHARED pool
    v_pool_stored NUMERIC := 0; 
    v_pool_price NUMERIC := 0;
    
    -- New state of the SHARED pool
    v_new_pool_stored NUMERIC; 
    v_new_pool_price NUMERIC;
    
    -- Intermediate calculations for surplus and deficit on phases
    v_charge_kwh NUMERIC := 0;
    v_charge_cost NUMERIC := 0;
    v_discharge_kwh NUMERIC := 0;
    
    -- Grid prices
    v_spot_price NUMERIC;
    v_dist_fee NUMERIC;
    v_grid_price NUMERIC;
BEGIN
    -- 1. Determine total grid import and PV (solar) production for the interval (split by L1, L2, L3)
    SELECT COALESCE(SUM(energy_l1_kwh), 0), COALESCE(SUM(energy_l2_kwh), 0), COALESCE(SUM(energy_l3_kwh), 0)
    INTO v_import_l1, v_import_l2, v_import_l3 
    FROM readings r JOIN devices d ON r.device_id = d.id 
    WHERE d.is_main_meter = TRUE AND r.interval_start = p_interval_start;
    
    SELECT COALESCE(SUM(energy_l1_kwh), 0), COALESCE(SUM(energy_l2_kwh), 0), COALESCE(SUM(energy_l3_kwh), 0)
    INTO v_fve_l1, v_fve_l2, v_fve_l3 
    FROM readings r JOIN devices d ON r.device_id = d.id 
    WHERE d.is_fve_production = TRUE AND r.interval_start = p_interval_start;
    
    -- 2. Sum of all measured Shelly appliances by phases
    SELECT COALESCE(SUM(energy_l1_kwh), 0), COALESCE(SUM(energy_l2_kwh), 0), COALESCE(SUM(energy_l3_kwh), 0)
    INTO v_shelly_l1, v_shelly_l2, v_shelly_l3 
    FROM readings r JOIN devices d ON r.device_id = d.id 
    WHERE d.is_main_meter = FALSE AND d.is_fve_production = FALSE AND r.interval_start = p_interval_start;
    
    -- 3. Determine the current spot price and distribution fee for this interval
    SELECT COALESCE(price_czk_kwh, 0) INTO v_spot_price FROM spot_prices WHERE hour_timestamp = date_trunc('hour', p_interval_start);
    SELECT COALESCE(variable_fee_czk_kwh, 0) INTO v_dist_fee FROM distribution_fees WHERE p_interval_start >= valid_from AND (p_interval_start <= valid_to OR valid_to IS NULL) LIMIT 1;
    v_grid_price := COALESCE(v_spot_price, 0) + COALESCE(v_dist_fee, 0);
    
    -- 4. Get the state of the SINGLE SHARED Virtual Pool from the previous interval
    SELECT pool_kwh_stored, pool_weighted_price_czk
    INTO v_pool_stored, v_pool_price
    FROM virtual_pool_state 
    WHERE interval_start < p_interval_start ORDER BY interval_start DESC LIMIT 1;
    
    v_pool_stored := COALESCE(v_pool_stored, 0); 
    v_pool_price := COALESCE(v_pool_price, 0);
    
    -- 5. Calculate charging / discharging on individual phases
    -- L1
    IF v_import_l1 > v_shelly_l1 THEN
        v_charge_kwh := v_charge_kwh + (v_import_l1 - v_shelly_l1);
        v_charge_cost := v_charge_cost + ((v_import_l1 - v_shelly_l1) * v_grid_price);
    ELSIF v_shelly_l1 > (v_import_l1 + v_fve_l1) THEN
        v_discharge_kwh := v_discharge_kwh + (v_shelly_l1 - (v_import_l1 + v_fve_l1));
    END IF;

    -- L2
    IF v_import_l2 > v_shelly_l2 THEN
        v_charge_kwh := v_charge_kwh + (v_import_l2 - v_shelly_l2);
        v_charge_cost := v_charge_cost + ((v_import_l2 - v_shelly_l2) * v_grid_price);
    ELSIF v_shelly_l2 > (v_import_l2 + v_fve_l2) THEN
        v_discharge_kwh := v_discharge_kwh + (v_shelly_l2 - (v_import_l2 + v_fve_l2));
    END IF;

    -- L3
    IF v_import_l3 > v_shelly_l3 THEN
        v_charge_kwh := v_charge_kwh + (v_import_l3 - v_shelly_l3);
        v_charge_cost := v_charge_cost + ((v_import_l3 - v_shelly_l3) * v_grid_price);
    ELSIF v_shelly_l3 > (v_import_l3 + v_fve_l3) THEN
        v_discharge_kwh := v_discharge_kwh + (v_shelly_l3 - (v_import_l3 + v_fve_l3));
    END IF;
    
    -- 6. Apply to the shared pool
    -- First, add all charging (average price will change)
    IF v_charge_kwh > 0 THEN
        v_new_pool_price := ((v_pool_stored * v_pool_price) + v_charge_cost) / (v_pool_stored + v_charge_kwh);
        v_pool_stored := v_pool_stored + v_charge_kwh;
        v_pool_price := v_new_pool_price;
    END IF;

    -- Then, subtract discharging (price remains the same)
    IF v_discharge_kwh > 0 THEN
        v_pool_stored := GREATEST(0, v_pool_stored - v_discharge_kwh);
    END IF;
    
    -- 7. Save the new state of the shared pool
    INSERT INTO virtual_pool_state (interval_start, pool_kwh_stored, pool_weighted_price_czk)
    VALUES (p_interval_start, v_pool_stored, v_pool_price)
    ON CONFLICT (interval_start) DO UPDATE SET 
        pool_kwh_stored = EXCLUDED.pool_kwh_stored, 
        pool_weighted_price_czk = EXCLUDED.pool_weighted_price_czk;

END;
$$ LANGUAGE plpgsql;

-- TRIGGER to automatically remap data from L1 to the correct phase for single-phase devices (Shelly 1PM)
CREATE OR REPLACE FUNCTION remap_phases_before_insert()
RETURNS TRIGGER AS $$
DECLARE
    v_phase_conn SMALLINT;
BEGIN
    SELECT phase_connection INTO v_phase_conn FROM devices WHERE id = NEW.device_id;
    
    IF v_phase_conn = 2 THEN
        NEW.energy_l2_kwh := NEW.energy_l1_kwh;
        NEW.energy_l1_kwh := 0;
    ELSIF v_phase_conn = 3 THEN
        NEW.energy_l3_kwh := NEW.energy_l1_kwh;
        NEW.energy_l1_kwh := 0;
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_remap_phases ON readings;
CREATE TRIGGER trg_remap_phases
BEFORE INSERT ON readings
FOR EACH ROW EXECUTE FUNCTION remap_phases_before_insert();
