// system_health.js - Hardware watchdog and script monitor for Shelly
// Deployed via central deployment pipeline

let TELEGRAM_TOKEN = "";
let TELEGRAM_CHAT_ID = "";
let CHECK_INTERVAL = 5 * 60 * 1000; // Check every 5 minutes
let MIN_FREE_RAM = 25000; // 25KB threshold for safe operation

function sendTelegramAlert(message) {
    if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;
    
    let url = "https://api.telegram.org/bot" + TELEGRAM_TOKEN + 
              "/sendMessage?chat_id=" + TELEGRAM_CHAT_ID + 
              "&text=" + message;
              
    Shelly.call("HTTP.GET", { url: url }, function(res, err, msg) {
        if (err !== 0) print("Failed to send Telegram alert");
    });
}

function checkSystem() {
    print("Running system health check...");
    
    // 1. Check RAM
    Shelly.call("Sys.GetStatus", {}, function(sysStatus, sysErr) {
        if (sysErr === 0 && sysStatus) {
            if (sysStatus.ram_free < MIN_FREE_RAM) {
                print("CRITICAL: Low RAM detected! Free: " + JSON.stringify(sysStatus.ram_free));
                sendTelegramAlert("⚠️ *Shelly Alert* [" + Shelly.getDeviceInfo().mac + "]\nCRITICAL: Low RAM detected (" + JSON.stringify(sysStatus.ram_free) + " bytes). Rebooting device to clear memory pool.");
                
                // Reboot after 5 seconds to ensure message sends
                Timer.set(5000, false, function() {
                    Shelly.call("Shelly.Reboot", {});
                });
                return; // Stop checking further, we are rebooting
            }
        }
        
        // 2. Check Scripts
        Shelly.call("Script.List", {}, function(res, err) {
            if (err === 0 && res && res.scripts) {
                for (let i = 0; i < res.scripts.length; i++) {
                    let script = res.scripts[i];
                    // If a script is enabled (supposed to run) but is not running, and it's not THIS script
                    if (script.enable === true && script.running === false && script.name !== "system_health") {
                        print("CRITICAL: Script " + script.name + " crashed!");
                        sendTelegramAlert("🚨 *Shelly Alert* [" + Shelly.getDeviceInfo().mac + "]\nScript `" + script.name + "` has crashed or stopped! Attempting to auto-restart...");
                        
                        // Attempt auto-restart
                        Shelly.call("Script.Start", { id: script.id }, function(sr, se) {
                            if (se === 0) {
                                sendTelegramAlert("✅ *Shelly Recovery*\nScript `" + script.name + "` was successfully restarted.");
                            } else {
                                sendTelegramAlert("❌ *Shelly Error*\nFailed to restart script `" + script.name + "`!");
                            }
                        });
                    }
                }
            }
        });
    });
}

// Initialization
function init() {
    Shelly.call("KVS.Get", { key: "telegram_bot_token" }, function(resT, errT) {
        if (errT === 0 && resT && typeof resT.value === "string") {
            TELEGRAM_TOKEN = resT.value;
            Shelly.call("KVS.Get", { key: "telegram_chat_id" }, function(resC, errC) {
                if (errC === 0 && resC && typeof resC.value === "string") {
                    TELEGRAM_CHAT_ID = resC.value;
                    print("System Health Monitor initialized. Telegram connected.");
                    
                    // Send startup notification
                    sendTelegramAlert("ℹ️ *Shelly Info* [" + Shelly.getDeviceInfo().mac + "]\nSystem Health Watchdog initialized and running.");
                    
                    // Start checking loop
                    Timer.set(CHECK_INTERVAL, true, checkSystem);
                    
                } else {
                    print("ERROR: telegram_chat_id not found in KVS");
                }
            });
        } else {
            print("ERROR: telegram_bot_token not found in KVS");
        }
    });
}

init();
