// Configuration Block
let CONFIG = {
  DEBUG: false, // Set to true to see logs in the Shelly Console
  PHASE_OVERLOAD_THRESHOLD: 3200, // Threshold in Watts
  POLL_INTERVAL_MS: 5000, // Evaluation loop timer (5 seconds for trailing history)
  ALERT_COOLDOWN_SEC: 600, // 10 minutes wait before another alert
  MAIN_BREAKER_IP: "192.168.1.182", // FVE is the main breaker
  SCRIPT_ENDPOINT_PATH: "/script/1/trigger_upload", // Ensure script is saved in slot 1
  
  // Map IPs to readable names so Telegram messages are clear
  SHELLY_DEVICES: {
    "192.168.1.250": "Druhe patro",
    "192.168.1.180": "Zahrada",
    "192.168.1.162": "Prvni patro",
    "192.168.1.123": "Podkrovi",
    "192.168.1.182": "Pripojka"
  },
  
  SUPABASE_ENDPOINT_URL: "https://nvgxivswvpoexjypzblj.supabase.co/functions/v1/overload-handler",
  SUPABASE_AUTH_HEADER: "Bearer S-kEC-FHBzHV7b9"
};

let ALL_SHELLY_IPS = [];
for (let ip in CONFIG.SHELLY_DEVICES) {
  ALL_SHELLY_IPS.push(ip);
}

let localIp = "unknown";
let cooldownTicks = 0; 
let localLoadHistory = {}; 
let currentPower = { A: 0, B: 0, C: 0 }; // Lightweight state for the /power endpoint

// Dynamically find local IP
Shelly.call("Wifi.GetStatus", {}, function (res, err_code) {
  if (err_code === 0 && res) {
    if (res.sta_ip) localIp = res.sta_ip; 
    else if (res.sta && res.sta.ip) localIp = res.sta.ip; 
  }
});
Shelly.call("Eth.GetStatus", {}, function (res, err_code) {
  if (err_code === 0 && res && res.ip) {
    localIp = res.ip;
  }
});

function getDeviceName(ip) {
  if (CONFIG.SHELLY_DEVICES[ip]) {
    return CONFIG.SHELLY_DEVICES[ip];
  }
  return "Device_" + ip;
}

// ----------------------------------------------------
// HTTP ENDPOINTS
// ----------------------------------------------------

// 1. Silent History Upload Endpoint (Called during overload)
HTTPServer.registerEndpoint("trigger_upload", function(req, res) {
  let eId = "unknown";
  if (req.query && req.query.indexOf("event_id=") >= 0) {
      eId = req.query.slice(req.query.indexOf("event_id=") + 9);
  }
  if (CONFIG.DEBUG) print("Received network trigger for event: ", eId);
  sendPayload(eId, true, [], []);
  res.code = 200;
  res.body = "OK";
  res.send();
});

// 2. Ultra-lightweight Power Polling Endpoint (Eliminates OOM)
HTTPServer.registerEndpoint("power", function(req, res) {
  res.code = 200;
  res.body = JSON.stringify(currentPower);
  res.send();
});

let payloadLock = false;

function sendPayload(eventId, isSilent, breachedValues, measurements) {
  let payload = {
    event_id: eventId,
    silent_upload: isSilent,
    trigger_device_name: getDeviceName(localIp),
    trigger_device_ip: localIp,
    is_main_breaker: localIp === CONFIG.MAIN_BREAKER_IP,
    threshold_limit: CONFIG.PHASE_OVERLOAD_THRESHOLD,
    breached_values: breachedValues,
    local_load_history_1m: localLoadHistory,
    measurements: measurements
  };
  
  if (CONFIG.DEBUG) print("Sending payload for event: ", eventId);
  
  Shelly.call(
    "HTTP.Request",
    {
      method: "POST",
      url: CONFIG.SUPABASE_ENDPOINT_URL,
      headers: {
        "Authorization": CONFIG.SUPABASE_AUTH_HEADER,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    },
    function (res, error_code, error_msg) {
      if (!isSilent) payloadLock = false;
    }
  );
}

// ----------------------------------------------------
// POLLING LOGIC
// ----------------------------------------------------
let pollState = {
  active: false,
  measurements: [],
  currentIndex: 0,
  localStatusRes: null,
  breached: []
};

function recordPhase(phaseKey, pwr) {
  if (typeof pwr === "undefined") return false;
  if (!localLoadHistory[phaseKey]) localLoadHistory[phaseKey] = [];
  localLoadHistory[phaseKey].push(pwr);
  if (localLoadHistory[phaseKey].length > 12) {
    localLoadHistory[phaseKey].splice(0, 1);
  }
  return Math.abs(pwr) > CONFIG.PHASE_OVERLOAD_THRESHOLD;
}

// Hoisted Broadcast callback to prevent memory leaks
function handleBroadcastResponse() {
  broadcastNext(pollState.currentIndex + 1);
}

function broadcastNext(idx) {
  pollState.currentIndex = idx;
  if (idx >= ALL_SHELLY_IPS.length) {
    // Done broadcasting, inject Main Breaker data
    pollState.measurements.push({ device_name: getDeviceName(localIp), device_ip: localIp, A: currentPower.A, B: currentPower.B, C: currentPower.C });
    sendPayload(pollState.eventId, false, pollState.breached, pollState.measurements);
    return;
  }
  let targetIp = ALL_SHELLY_IPS[idx];
  if (targetIp === localIp) {
    broadcastNext(idx + 1);
    return;
  }
  Shelly.call("HTTP.Request", { method: "GET", url: "http://" + targetIp + CONFIG.SCRIPT_ENDPOINT_PATH + "?event_id=" + pollState.eventId, timeout: 5 }, handleBroadcastResponse);
}

function processPollingData() {
  let overloaded = false;
  pollState.breached.splice(0, pollState.breached.length); // Clear without reallocation
  
  // 1. Process Local Hardware
  if (pollState.localStatusRes) {
    let res = pollState.localStatusRes;
    currentPower.A = 0; currentPower.B = 0; currentPower.C = 0;
    
    for (let key in res) {
      let comp = res[key];
      if (key.indexOf("emeter:") === 0 || key.indexOf("pm1:") === 0 || key.indexOf("switch:") === 0) {
        if (recordPhase(key, comp.power)) overloaded = true;
        if (recordPhase(key, comp.apower)) overloaded = true;
        currentPower.A = typeof comp.power !== "undefined" ? comp.power : comp.apower;
      } else if (key.indexOf("em:") === 0 || key.indexOf("em1:") === 0) {
        if (recordPhase(key + "_A", comp.a_act_power)) overloaded = true;
        if (recordPhase(key + "_B", comp.b_act_power)) overloaded = true;
        if (recordPhase(key + "_C", comp.c_act_power)) overloaded = true;
        
        if (typeof comp.a_act_power !== "undefined") currentPower.A = comp.a_act_power;
        if (typeof comp.b_act_power !== "undefined") currentPower.B = comp.b_act_power;
        if (typeof comp.c_act_power !== "undefined") currentPower.C = comp.c_act_power;
      }
    }
  }

  // 2. Process virtual Wattsonic sums (Main Breaker Only)
  if (localIp === CONFIG.MAIN_BREAKER_IP) {
    let sumA = 0, sumB = 0, sumC = 0;
    for (let i = 0; i < pollState.measurements.length; i++) {
      let m = pollState.measurements[i];
      if (typeof m.A !== "undefined") sumA += m.A;
      if (typeof m.B !== "undefined") sumB += m.B;
      if (typeof m.C !== "undefined") sumC += m.C;
    }
    
    overloaded = false; // Main Breaker strictly uses Wattsonic for trigger
    if (recordPhase("Wattsonic_A", sumA)) { overloaded = true; pollState.breached.push({phase: "Wattsonic_A", recorded_value: sumA}); }
    if (recordPhase("Wattsonic_B", sumB)) { overloaded = true; pollState.breached.push({phase: "Wattsonic_B", recorded_value: sumB}); }
    if (recordPhase("Wattsonic_C", sumC)) { overloaded = true; pollState.breached.push({phase: "Wattsonic_C", recorded_value: sumC}); }
    
    if (CONFIG.DEBUG) print("Wattsonic Sums -> A: ", sumA, ", B: ", sumB, ", C: ", sumC, ", Trigger: ", overloaded);
    
    if (cooldownTicks > 0) cooldownTicks--;
    
    if (overloaded) {
      if (cooldownTicks <= 0) {
        if (CONFIG.DEBUG) print("Wattsonic Overload detected! Starting Coordinated Broadcast.");
        if (!payloadLock) {
           payloadLock = true;
           pollState.eventId = "evt_" + Math.round(Math.random() * 1000000);
           cooldownTicks = Math.round(CONFIG.ALERT_COOLDOWN_SEC / (CONFIG.POLL_INTERVAL_MS / 1000));
           broadcastNext(0);
        }
      } else {
        if (CONFIG.DEBUG) print("Overload detected, but script is in Cooldown.");
      }
    }
  }

  pollState.active = false;
}

// Hoisted Network Fetch callback
function handleSubpanelResponse(res, err_code, err_msg, passedIp) {
  if (err_code === 0 && res && res.code === 200) {
    let b = res.body;
    if (res.body_b64) b = atob(res.body_b64);
    
    let parsed = null;
    if (typeof b === "object") parsed = b;
    else if (typeof b === "string" && b.indexOf("{") >= 0) parsed = JSON.parse(b);
    
    if (parsed) {
      let measurement = { device_name: getDeviceName(passedIp), device_ip: passedIp };
      if (typeof parsed.A !== "undefined") measurement.A = parsed.A;
      if (typeof parsed.B !== "undefined") measurement.B = parsed.B;
      if (typeof parsed.C !== "undefined") measurement.C = parsed.C;
      pollState.measurements.push(measurement);
    }
  }
  fetchNextSubpanel(pollState.currentIndex + 1);
}

function fetchNextSubpanel(idx) {
  pollState.currentIndex = idx;
  if (idx >= ALL_SHELLY_IPS.length) {
    processPollingData();
    return;
  }
  let ip = ALL_SHELLY_IPS[idx];
  if (ip === localIp) {
    fetchNextSubpanel(idx + 1);
    return;
  }
  
  Shelly.call("HTTP.Request", { method: "GET", url: "http://" + ip + "/script/1/power", timeout: 5 }, handleSubpanelResponse, ip);
}

// Hoisted Local Status callback
function handleLocalStatus(res, err_code) {
  if (err_code === 0 && res) {
    pollState.localStatusRes = res;
  }
  if (localIp === CONFIG.MAIN_BREAKER_IP) {
    fetchNextSubpanel(0);
  } else {
    processPollingData();
  }
}

function runPollingCycle() {
  if (pollState.active) return;
  pollState.active = true;
  pollState.measurements.splice(0, pollState.measurements.length); // Clear without reallocation
  pollState.localStatusRes = null;
  
  Shelly.call("Shelly.GetStatus", {}, handleLocalStatus);
}

Timer.set(CONFIG.POLL_INTERVAL_MS, true, function() {
  if (localIp !== "unknown") runPollingCycle();
});
if (CONFIG.DEBUG) print("Script started...");
