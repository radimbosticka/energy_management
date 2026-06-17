-- Table for defining distribution fees (valid from-to)
CREATE TABLE distribution_fees (
    id SERIAL PRIMARY KEY,
    valid_from TIMESTAMP WITH TIME ZONE NOT NULL,
    valid_to TIMESTAMP WITH TIME ZONE,
    variable_fee_czk_kwh NUMERIC(10, 4) NOT NULL,
    fixed_monthly_fee_czk NUMERIC(10, 2) NOT NULL,
    description TEXT
);

-- Table for spot prices from OTE / spotovky.cz
CREATE TABLE spot_prices (
    hour_timestamp TIMESTAMP WITH TIME ZONE PRIMARY KEY,
    price_czk_mwh NUMERIC(10, 2) NOT NULL,
    price_czk_kwh NUMERIC(10, 4) GENERATED ALWAYS AS (price_czk_mwh / 1000) STORED
);

-- Table for Shelly devices registry
CREATE TABLE devices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    mac_address VARCHAR(17) UNIQUE NOT NULL,
    name VARCHAR(100) NOT NULL,
    category SMALLINT NOT NULL DEFAULT 2, -- 1: PV Priority (Solar), 2: Standard
    is_main_meter BOOLEAN DEFAULT FALSE,
    is_fve_production BOOLEAN DEFAULT FALSE,
    phase_connection SMALLINT DEFAULT 0 -- 0: 3-Phase (1,2,3), 1: Phase L1, 2: Phase L2, 3: Phase L3
);

-- Main table for data collection (Measurements are strictly per phase)
CREATE TABLE readings (
    id BIGSERIAL PRIMARY KEY,
    device_id UUID NOT NULL REFERENCES devices(id),
    interval_start TIMESTAMP WITH TIME ZONE NOT NULL,
    energy_l1_kwh NUMERIC(10, 5) DEFAULT 0,
    energy_l2_kwh NUMERIC(10, 5) DEFAULT 0,
    energy_l3_kwh NUMERIC(10, 5) DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    CONSTRAINT unique_device_interval UNIQUE(device_id, interval_start)
);

-- Table for maintaining the state of the "Virtual Pool"
-- The DC battery is physically only one, so the Pool is shared for the entire house
CREATE TABLE virtual_pool_state (
    interval_start TIMESTAMP WITH TIME ZONE PRIMARY KEY,
    pool_kwh_stored NUMERIC(10, 4) DEFAULT 0,
    pool_weighted_price_czk NUMERIC(10, 4) DEFAULT 0
);

CREATE INDEX idx_readings_interval ON readings(interval_start);
CREATE INDEX idx_readings_device ON readings(device_id);
