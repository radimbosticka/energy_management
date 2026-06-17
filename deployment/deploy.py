import json
import urllib.request
import urllib.error
import os
import time

def rpc_call(ip, method, params=None):
    url = f"http://{ip}/rpc/{method}"
    headers = {"Content-Type": "application/json"}
    data = None
    if params:
        data = json.dumps(params).encode("utf-8")
        
    req = urllib.request.Request(url, data=data, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=10) as response:
            res = json.loads(response.read().decode())
            return res
    except urllib.error.URLError as e:
        print(f"  [ERROR] RPC {method} failed on {ip}: {e}")
        return None

def set_kvs(ip, key, value):
    print(f"  Setting KVS {key}...")
    rpc_call(ip, "KVS.Set", {"key": key, "value": str(value)})

def deploy_script(ip, script_name, code_path):
    print(f"  Deploying {script_name}...")
    
    # 1. Read code
    with open(code_path, "r", encoding="utf-8") as f:
        code = f.read()

    # 2. Check if script exists, get ID
    scripts = rpc_call(ip, "Script.List")
    if not scripts or "scripts" not in scripts:
        print("  [ERROR] Failed to list scripts")
        return
        
    script_id = None
    for s in scripts["scripts"]:
        if s.get("name") == script_name:
            script_id = s.get("id")
            break
            
    # 3. Create if not exists
    if script_id is None:
        print(f"  Creating new script slot for {script_name}")
        res = rpc_call(ip, "Script.Create", {"name": script_name})
        if res and "id" in res:
            script_id = res["id"]
        else:
            print("  [ERROR] Failed to create script")
            return
            
    # 4. Stop script if running
    rpc_call(ip, "Script.Stop", {"id": script_id})
    time.sleep(1) # Give it a second to stop
    
    # 5. Upload code in chunks (Shelly API limits size)
    # Shelly Gen2 usually handles ~3KB chunks well
    CHUNK_SIZE = 2500 
    
    print(f"  Uploading {len(code)} bytes in chunks...")
    for i in range(0, len(code), CHUNK_SIZE):
        chunk = code[i:i+CHUNK_SIZE]
        is_append = (i > 0)
        
        res = rpc_call(ip, "Script.PutCode", {
            "id": script_id,
            "code": chunk,
            "append": is_append
        })
        
        if res is None:
            print("  [ERROR] Code upload failed")
            return
            
    # 6. Enable auto-start
    rpc_call(ip, "Script.SetConfig", {
        "id": script_id,
        "config": {"enable": True}
    })
    
    # 7. Start script
    print(f"  Starting {script_name}...")
    rpc_call(ip, "Script.Start", {"id": script_id})
    print(f"  [SUCCESS] {script_name} deployed and started!")

def main():
    inventory_path = os.path.join(os.path.dirname(__file__), "inventory.json")
    scripts_dir = os.path.join(os.path.dirname(os.path.dirname(__file__)), "scripts")
    
    with open(inventory_path, "r") as f:
        inv = json.load(f)
        
    config = inv.get("config", {})
    
    print("=== Shelly Fleet Deployment Pipeline ===")
    for device in inv.get("devices", []):
        ip = device["ip"]
        name = device["name"]
        print(f"\n--- Processing Device: {name} ({ip}) ---")
        
        # 1. Inject configurations into KVS
        if config.get("supabase_url"):
            set_kvs(ip, "supabase_url", config["supabase_url"])
        if config.get("supabase_key"):
            set_kvs(ip, "supabase_key", config["supabase_key"])
        if config.get("telegram_bot_token"):
            set_kvs(ip, "telegram_bot_token", config["telegram_bot_token"])
        if config.get("telegram_chat_id"):
            set_kvs(ip, "telegram_chat_id", config["telegram_chat_id"])
            
        # 2. Deploy selected scripts
        for script_name in device.get("scripts", []):
            code_path = os.path.join(scripts_dir, script_name, f"{script_name}.js")
            if os.path.exists(code_path):
                deploy_script(ip, script_name, code_path)
            else:
                print(f"  [WARNING] Source code for {script_name} not found at {code_path}")

if __name__ == "__main__":
    main()
