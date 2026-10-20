import subprocess
import time
import re
import webbrowser
import os
import sys

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
SERVER_JS = os.path.join(BASE_DIR, 'server.js')
CLOUDFLARED = os.path.join(BASE_DIR, 'cloudflared.exe')

print("=" * 66)
print("  🐺 6人狼人殺 — 全球外網連線啟動器")
print("  朋友天南地北、用手機 4G/5G 都能直接加入！")
print("=" * 66)
print("\n[1/2] 正在啟動本機狼人殺遊戲伺服器...")

# Start node server
node_proc = subprocess.Popen(['node', SERVER_JS], cwd=BASE_DIR)

time.sleep(1.5)

print("[2/2] 正在建立 Cloudflare 國際安全穿透隧道 (HTTPS)...")

# Start cloudflared
cf_proc = subprocess.Popen([CLOUDFLARED, 'tunnel', '--url', 'http://localhost:8080'],
                           cwd=BASE_DIR,
                           stderr=subprocess.PIPE,
                           stdout=subprocess.PIPE,
                           text=True,
                           bufsize=1)

public_url = None
start_time = time.time()
while time.time() - start_time < 20:
    line = cf_proc.stderr.readline()
    if 'trycloudflare.com' in line:
        m = re.search(r'https://[a-zA-Z0-9-]+\.trycloudflare\.com', line)
        if m:
            public_url = m.group(0)
            break

if public_url:
    print("\n" + "★" * 66)
    print("  🎉 連線建立成功！請直接將下方專屬網址傳給所有朋友：")
    print()
    print(f"      👉  {public_url}  👈")
    print()
    print("  • 支援手機 (LINE/Messenger 直接點開)、平板、電腦！")
    print("  • 免下載、免註冊，進房輸入 4 位數代碼即可秒開局！")
    print("★" * 66 + "\n")
    print("💡 提示：按 Ctrl + C 可關閉伺服器。\n")
    
    # Automatically open in browser
    webbrowser.open(public_url)
else:
    print("\n無法取得公網網址，請確認網路連線正常。已為您開啟本機網址: http://localhost:8080")
    webbrowser.open("http://localhost:8080")

try:
    while True:
        time.sleep(1)
except KeyboardInterrupt:
    print("\n正在關閉伺服器與連線...")
    node_proc.terminate()
    cf_proc.terminate()
    print("已成功退出。")
