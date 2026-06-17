import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const TELEGRAM_BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN");
const TELEGRAM_CHAT_ID = Deno.env.get("TELEGRAM_CHAT_ID");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const API_AUTH_SECRET = Deno.env.get("API_AUTH_SECRET");

serve(async (req) => {
  // Only accept POST requests
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  // Verify Authorization header
  const authHeader = req.headers.get("Authorization");
  if (authHeader !== `Bearer ${API_AUTH_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  let payload;
  try {
    payload = await req.json();
  } catch (e) {
    return new Response("Invalid JSON payload", { status: 400 });
  }

  const {
    event_id,
    silent_upload,
    trigger_device_name,
    trigger_device_ip,
    is_main_breaker,
    threshold_limit,
    breached_values,
    local_load_history_1m,
    measurements
  } = payload;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error("Missing Supabase configuration");
    return new Response("Internal Server Error", { status: 500 });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // 1. Database Operation
  const { error: dbError } = await supabase
    .from("phase_overload_events")
    .insert([{
      event_id,
      trigger_device_name,
      is_main_breaker,
      threshold_limit,
      breached_values,
      local_load_history_1m,
      measurements
    }]);

  if (dbError) {
    console.error("Database insert error:", dbError);
    return new Response("Failed to log event", { status: 500 });
  }

  // 2. Telegram Integration
  if (silent_upload) {
    console.log("Silent upload requested (Secondary Panel). Skipping Telegram alert.");
    return new Response(JSON.stringify({ success: true, message: "Logged silently" }), {
      headers: { "Content-Type": "application/json" },
      status: 200
    });
  }

  if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
    let breachedText = "";
    if (breached_values && Array.isArray(breached_values)) {
      breachedText = breached_values.map((v: any) => `- ${v.phase}: ${v.recorded_value} W`).join('\n');
    }

    let mainBreakerText = "Not reachable or missing in this collection";
    let otherMeasurementsText = "";
    
    if (measurements && Array.isArray(measurements)) {
      // Find Main Breaker (192.168.1.182)
      const mainBreaker = measurements.find(m => m.device_ip === "192.168.1.182");
      if (mainBreaker) {
        mainBreakerText = "";
        Object.keys(mainBreaker).forEach(k => {
          if (k !== 'device_name' && k !== 'device_ip' && k !== 'error') {
            mainBreakerText += `  • ${k}: ${mainBreaker[k]} W\n`;
          }
        });
        if (mainBreaker.error) mainBreakerText += `  • Error: ${mainBreaker.error}\n`;
      }
      
      otherMeasurementsText = measurements.filter(m => m.device_ip !== "192.168.1.182").map((m: any) => {
        let mText = `- ${m.device_name} (${m.device_ip}):\n`;
        Object.keys(m).forEach(k => {
          if (k !== 'device_name' && k !== 'device_ip' && k !== 'error') {
            mText += `  • ${k}: ${m[k]} W\n`;
          }
        });
        if (m.error) mText += `  • Error: ${m.error}\n`;
        return mText;
      }).join('');
    }
    
    let historyText = "";
    if (local_load_history_1m && typeof local_load_history_1m === 'object') {
      let wA = local_load_history_1m["Wattsonic_A"] || [];
      let wB = local_load_history_1m["Wattsonic_B"] || [];
      let wC = local_load_history_1m["Wattsonic_C"] || [];
      
      let fveA = local_load_history_1m["em:0_A"] || local_load_history_1m["em1:0_A"] || [];
      let fveB = local_load_history_1m["em:0_B"] || local_load_history_1m["em1:0_B"] || [];
      let fveC = local_load_history_1m["em:0_C"] || local_load_history_1m["em1:0_C"] || [];

      if (wA.length > 0 || wB.length > 0 || wC.length > 0) {
        historyText += `\n*Wattsonic Load History (Last 60 seconds):*\n`;
        historyText += `\`\`\`text\n`;
        historyText += `Sec  | A     | B     | C    \n`;
        historyText += `-----------------------------\n`;

        const maxRows = 12;
        const totalRows = Math.max(wA.length, wB.length, wC.length);
        const rowsToShow = Math.min(totalRows, maxRows);

        for (let i = 0; i < rowsToShow; i++) {
          // Read from end of array (newest is last)
          const idx = totalRows - 1 - i;
          let a = wA[idx] !== undefined ? Math.round(wA[idx]) : "---";
          let b = wB[idx] !== undefined ? Math.round(wB[idx]) : "---";
          let c = wC[idx] !== undefined ? Math.round(wC[idx]) : "---";

          historyText += `-${i * 5}`.padEnd(5) + `| ` + `${a}`.padEnd(6) + `| ` + `${b}`.padEnd(6) + `| ` + `${c}`.padEnd(5) + `\n`;
        }
        historyText += `\`\`\`\n`;
      }
      
      if (fveA.length > 0 || fveB.length > 0 || fveC.length > 0) {
        historyText += `\n*FVE Grid Hardware (Current):*\n`;
        let curFveA = fveA[fveA.length - 1];
        let curFveB = fveB[fveB.length - 1];
        let curFveC = fveC[fveC.length - 1];
        historyText += `  • A: ${curFveA} W\n`;
        historyText += `  • B: ${curFveB} W\n`;
        historyText += `  • C: ${curFveC} W\n`;
      }
    }

    const text = `⚠️ *Phase Overload Detected!*\n\n` +
      `*Trigger Device:* ${trigger_device_name} (${trigger_device_ip})\n` +
      `*Threshold:* ${threshold_limit} W\n\n` +
      `*Main Circuit Breaker State:*\n${mainBreakerText}\n` +
      `*Breached Values:*\n${breachedText}\n\n` +
      historyText +
      `*Subpanel Measurements:*\n${otherMeasurementsText}`;

    try {
      const tgRes = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: TELEGRAM_CHAT_ID,
          text: text
        })
      });
      
      if (!tgRes.ok) {
        const errorBody = await tgRes.text();
        console.error("Telegram API rejected the request:", tgRes.status, errorBody);
      }
    } catch (telegramError) {
      console.error("Telegram network error:", telegramError);
    }
  } else {
    console.warn("Telegram credentials not configured, skipping alert.");
  }

  return new Response(JSON.stringify({ success: true }), {
    headers: { "Content-Type": "application/json" },
    status: 200
  });
});
