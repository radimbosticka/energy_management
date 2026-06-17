// Global variables from KVS
let SUPABASE_URL = "";
let SUPABASE_KEY = "";

// DEBUG Mode - Set to true to send a test message on startup
let DEBUG_MODE = false; 

// Auto-detect MAC address
let DEVICE_MAC = Shelly.getDeviceInfo().mac;

// RAM Buffer for unsent data
let unsentReadings = [];
let MAX_BUFFER_SIZE = 96; // 24 hours at 15min interval

let MEASURE_INTERVAL = 15 * 60 * 1000;
let SEND_INTERVAL = 60 * 1000;

// Helper variables
let lastEnergyL1 = null;
let lastEnergyL2 = null;
let lastEnergyL3 = null;

// Function to read energy from device (supports 1-phase and 3-phase)
function readEnergy() {
    Shelly.call("EMData.GetStatus", { id: 0 }, function(result, err_code, err_msg) {
        if (err_code === 0 && result) {
            processEnergyResult(
                result.a_total_act_energy / 1000.0,
                result.b_total_act_energy / 1000.0,
                result.c_total_act_energy / 1000.0
            );
        } else {
            Shelly.call("Switch.GetStatus", { id: 0 }, function(res_sw, err_sw, msg_sw) {
                if (err_sw === 0 && res_sw && res_sw.aenergy) {
                    processEnergyResult(res_sw.aenergy.total / 1000.0, 0, 0);
                } else {
                    print("Error reading energy consumption.");
                }
            });
        }
    });
}

function processEnergyResult(e1, e2, e3) {
    if (lastEnergyL1 !== null) {
        let delta1 = e1 - lastEnergyL1; if (delta1 < 0) delta1 = e1;
        let delta2 = e2 - lastEnergyL2; if (delta2 < 0) delta2 = e2;
        let delta3 = e3 - lastEnergyL3; if (delta3 < 0) delta3 = e3;
        
        let sysInfo = Shelly.getComponentStatus("sys");
        let currentTs = sysInfo && sysInfo.unixtime ? sysInfo.unixtime : 0;
        
        unsentReadings.push({
            ts: currentTs,
            l1: delta1,
            l2: delta2,
            l3: delta3
        });
        
        if (unsentReadings.length > MAX_BUFFER_SIZE) {
            unsentReadings.splice(0, unsentReadings.length - MAX_BUFFER_SIZE);
        }
        
        print("Saved to buffer. Total records: " + JSON.stringify(unsentReadings.length));
    }
    
    lastEnergyL1 = e1;
    lastEnergyL2 = e2;
    lastEnergyL3 = e3;
}

// Function to safely extract a clean string, avoiding .trim() and .replace() missing issues in mJS
function cleanString(str) {
    if (typeof str !== "string") return "";
    let start = 0;
    let end = str.length;
    while (start < end && (str.at(start) === " " || str.at(start) === "\n" || str.at(start) === "\r")) start++;
    while (end > start && (str.at(end - 1) === " " || str.at(end - 1) === "\n" || str.at(end - 1) === "\r")) end--;
    return str.slice(start, end);
}

// Function to generate the memory url safely without .replace()
function getMemoryUrl(url) {
    let searchStr = "insert_reading_by_mac";
    let replaceStr = "insert_memory_log_by_mac";
    let idx = url.indexOf(searchStr);
    if (idx >= 0) {
        return url.slice(0, idx) + replaceStr + url.slice(idx + searchStr.length, url.length);
    }
    return url;
}

// Function to generate debug url safely without .replace()
function getDebugUrl(url) {
    let searchStr = "insert_reading_by_mac";
    let replaceStr = "insert_debug_log";
    let idx = url.indexOf(searchStr);
    if (idx >= 0) {
        return url.slice(0, idx) + replaceStr + url.slice(idx + searchStr.length, url.length);
    }
    return url;
}


// Function to send data to Supabase
function sendData() {
    if (unsentReadings.length === 0) return;
    
    let reading = unsentReadings[0];
    
    let payload = {
        p_mac_address: DEVICE_MAC,
        p_interval_start_ts: reading.ts, // Use raw unix timestamp, no Date() object needed
        p_energy_l1_kwh: reading.l1,
        p_energy_l2_kwh: reading.l2,
        p_energy_l3_kwh: reading.l3
    };
    
    Shelly.call(
        "HTTP.Request",
        {
            method: "POST",
            url: SUPABASE_URL,
            headers: {
                "Content-Type": "application/json",
                "apikey": SUPABASE_KEY,
                "Authorization": "Bearer " + SUPABASE_KEY
            },
            body: JSON.stringify(payload)
        },
        function(result, err_code, err_msg) {
            if (err_code === 0 && (result.code === 200 || result.code === 201 || result.code === 204)) {
                print("Data sent successfully (L1/L2/L3)");
                unsentReadings.splice(0, 1);
                
                // Fire memory log in background
                sendMemoryLog();
            } else {
                let bodyStr = result && result.body ? result.body : "no body";
                print("Error sending data. HTTP code: " + JSON.stringify(result ? result.code : "null") + " | body: " + bodyStr);
            }
        }
    );
}

// Function to send dedicated memory log
function sendMemoryLog() {
    Shelly.call("Sys.GetStatus", {}, function(sysStatus, sysErr) {
        if (sysErr === 0 && sysStatus) {
            let memUrl = getMemoryUrl(SUPABASE_URL);
            let payload = {
                p_mac_address: DEVICE_MAC,
                p_ram_free: sysStatus.ram_free,
                p_ram_total: sysStatus.ram_size
            };
            
            Shelly.call("HTTP.Request", {
                method: "POST",
                url: memUrl,
                headers: {
                    "Content-Type": "application/json",
                    "apikey": SUPABASE_KEY,
                    "Authorization": "Bearer " + SUPABASE_KEY
                },
                body: JSON.stringify(payload)
            });
        }
    });
}

// Initialization - first load keys from KVS, then start logging
function init() {
    Shelly.call("KVS.Get", { key: "supabase_url" }, function (resUrl, errUrl) {
        if (errUrl === 0 && resUrl) {
            SUPABASE_URL = cleanString(resUrl.value);
            Shelly.call("KVS.Get", { key: "supabase_key" }, function (resKey, errKey) {
                if (errKey === 0 && resKey) {
                    SUPABASE_KEY = cleanString(resKey.value);
                    print("KVS loaded successfully. Starting logging. MAC: " + DEVICE_MAC);
                    
                    if (DEBUG_MODE) {
                        print("DEBUG_MODE ACTIVE: Sending test PING to log table...");
                        let debugUrl = getDebugUrl(SUPABASE_URL);
                        Shelly.call("HTTP.Request", {
                            method: "POST",
                            url: debugUrl,
                            headers: {
                                "Content-Type": "application/json",
                                "apikey": SUPABASE_KEY,
                                "Authorization": "Bearer " + SUPABASE_KEY
                            },
                            body: JSON.stringify({ p_mac_address: DEVICE_MAC, p_message: "Test write MAC" })
                        }, function(r, e, m) {
                            if (e === 0 && (r.code === 200 || r.code === 201 || r.code === 204)) {
                                print("PING successful!");
                            } else {
                                let bodyStr = r && r.body ? r.body : "no body";
                                print("PING failed! err_code: " + JSON.stringify(e) + ", http_code: " + JSON.stringify(r ? r.code : "null") + ", body: " + bodyStr);
                            }
                        });
                    }
                    
                    Timer.set(MEASURE_INTERVAL, true, readEnergy);
                    Timer.set(SEND_INTERVAL, true, sendData);
                    readEnergy(); // Initial measurement
                } else {
                    print("ERROR: 'supabase_key' not found in KVS. Please set it.");
                }
            });
        } else {
            print("ERROR: 'supabase_url' not found in KVS. Please set it.");
        }
    });
}

init();
