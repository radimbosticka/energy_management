# Project Specification: Phase Overload Detection System

## 1. System Overview
A distributed phase overload detection system using Shelly power meters (1-phase and 3-phase, supporting Gen1, Gen2, and Gen3 devices), Supabase for data logging, and Telegram for alerts. A single, uniform mJS script runs on all Shelly devices. It performs local polling every 5 seconds, maintains a memory-safe 10-minute rolling history of phase loads, and uses a custom lightweight HTTP endpoint (`/power`) to continuously sum the network load into a virtual "Wattsonic" device. If this virtual device breaches a threshold, it triggers a Coordinated Broadcast to silently gather historical data from all subpanels and dispatch a Telegram alert from the Main Breaker.

## 2. Component Requirements

### Component 1: Shelly Unified Script (`shelly_monitor.js`)
* **Uniformity:** A single, identical script must run unmodified on all participating Shelly devices.
* **Configuration Block:** Must exactly match the following:
```javascript
let CONFIG = {
  DEBUG: false,
  PHASE_OVERLOAD_THRESHOLD: 3200,
  POLL_INTERVAL_MS: 5000,
  ALERT_COOLDOWN_SEC: 600,
  MAIN_BREAKER_IP: "192.168.1.182", // Pripojka
  SCRIPT_ENDPOINT_PATH: "/script/1/trigger_upload",
  SHELLY_DEVICES: {
    "192.168.1.250": "Druhe patro",
    "192.168.1.180": "Zahrada",
    "192.168.1.162": "Prvni patro",
    "192.168.1.123": "Podkrovi",
    "192.168.1.182": "Pripojka"
  },
  SUPABASE_ENDPOINT_URL: "...",
  SUPABASE_AUTH_HEADER: "..."
};
```
* **Lightweight Network State (`/power` Endpoint):**
    * To prevent memory overflows on the Main Breaker, each subpanel continuously stores its instantaneous phase loads in a global `{A: 0, B: 0, C: 0}` object.
    * An HTTP endpoint `/script/1/power` serves this minimal JSON payload string.
* **Memory-Safe Rolling Aggregation:**
    * Poll local phases every 5 seconds.
    * Store the object representing the power levels into a column-oriented `localLoadHistory` dictionary of arrays.
    * Cap the arrays at 12 elements (1 minute) using `splice(0, 1)`.
* **Execution & Cooldown Logic:**
    * **Virtual Device Summation:** The Main Breaker polls the lightweight `/power` endpoint of all subpanels sequentially every 5 seconds. It aggregates these into a virtual `Wattsonic` sum.
    * **Base64 Decoding:** The Shelly `HTTP.Request` client natively parses valid JSON, but encapsulates raw objects lacking a Content-Type into a Base64 string (`res.body_b64`). The script explicitly intercepts and decodes this using `atob()`.
    * **Solar Export Handling:** History and measurements preserve raw negative/positive values (to track export direction). However, the trigger mechanism evaluates the *absolute magnitude* (`Math.abs(power) > PHASE_OVERLOAD_THRESHOLD`).
    * **CRITICAL CONSTRAINT:** Cooldowns MUST be implemented using a tick-based countdown counter (`cooldownTicks`). On every 5-second tick, decrement the counter. If `cooldownTicks <= 0`, allow the network collection.
    * If not on cooldown, the Main Breaker generates a unique `event_id` and initiates the **Coordinated Broadcast**.
* **Coordinated Broadcast Routing:**
    * The Main Breaker fires asynchronous HTTP GET requests to a local listener (`/script/1/trigger_upload?event_id=...`) on all other subpanels.
* **Payload Construction (Main Breaker vs Subpanel):**
    * Subpanels: Upon receiving the ping, they compile a payload featuring their own `local_load_history_1m` and flag `silent_upload = true`.
    * Main Breaker: Packages its own `local_load_history_1m` and sets `silent_upload = false`. Its `trigger_device_name` reports as its physical identity (e.g. Pripojka).
    * Both include the identical `event_id` so they can be grouped in the database.
* **Transmission:**
    * POST to `SUPABASE_ENDPOINT_URL`.

### Component 2: Supabase Edge Function (`supabase/functions/overload-handler/index.ts`)
* **Objective:** Receive the payload, write to the database, and trigger a Telegram notification (if applicable).
* **Request Handling:**
    * Validate the authorization header.
    * Parse `event_id`, `silent_upload`, and `local_load_history_1m`.
* **Database Operation:**
    * Insert all payloads into `phase_overload_events` with their respective `event_id`.
* **Telegram Integration:**
    * If `silent_upload === true`, the script intentionally drops the request silently.
    * If `silent_upload === false`, the script generates the main alert.
    * It dynamically extracts the lightweight `{A, B, C}` measurements from the payload.

### Component 3: Database Schema (`supabase/migrations/0001_initial_schema.sql`)
* **Table:** `phase_overload_events`
* **Columns:**
    * `id` (UUID)
    * `created_at` (Timestamptz)
    * `trigger_device_name` (Text)
    * `is_main_breaker` (Boolean)
    * `threshold_limit` (Numeric)
    * `breached_values` (JSONB)
    * `local_load_history_1m` (JSONB)
    * `measurements` (JSONB)