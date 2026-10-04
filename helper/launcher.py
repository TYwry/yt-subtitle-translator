"""Chrome「原生訊息」啟動器：只有本專案的擴充功能能呼叫。
功能只有兩個：在背景啟動本機助手（server.py），以及告訴擴充功能連線用的埠號與通行碼。
不接受任何路徑或指令參數，所以不能被拿來執行其他程式。"""
import json
import os
import struct
import subprocess
import sys
import time
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import HELPER_DIR, load_config  # noqa: E402


def read_msg():
    raw = sys.stdin.buffer.read(4)
    if len(raw) < 4:
        return None
    n = struct.unpack("<I", raw)[0]
    if n > 65536:
        return None
    return json.loads(sys.stdin.buffer.read(n).decode("utf-8"))


def send_msg(obj):
    data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(data)))
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()


def is_running(port):
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/ping", timeout=1.5) as r:
            return json.loads(r.read().decode()).get("app") == "ytsub-helper"
    except Exception:
        return False


def running_version(port):
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/ping", timeout=1.5) as r:
            j = json.loads(r.read().decode())
            return j.get("version", "") if j.get("app") == "ytsub-helper" else ""
    except Exception:
        return ""


def stop_helper(port, token):
    """結束正在執行的助手：先請它自己結束（1.2.1 起支援），舊版就找出占用這個埠的 server.py 強制結束。"""
    try:
        req = urllib.request.Request(f"http://127.0.0.1:{port}/quit", data=b"{}", method="POST",
                                     headers={"Content-Type": "application/json", "X-Ytsub-Token": token})
        urllib.request.urlopen(req, timeout=3).read()
    except Exception:
        pass
    for _ in range(10):
        if not is_running(port):
            return True
        time.sleep(0.3)
    flags = 0x08000000   # 不跳出黑色視窗
    out = subprocess.run(["netstat", "-ano", "-p", "TCP"], capture_output=True, text=True, creationflags=flags).stdout
    pids = {ln.split()[-1] for ln in out.splitlines()
            if "LISTENING" in ln and len(ln.split()) >= 5 and ln.split()[1].endswith(f":{port}")}
    for pid in pids:
        if not pid.isdigit():
            continue
        cmd = subprocess.run(["powershell", "-NoProfile", "-Command",
                              f"(Get-CimInstance Win32_Process -Filter 'ProcessId={pid}').CommandLine"],
                             capture_output=True, text=True, creationflags=flags).stdout
        if "server.py" in cmd and "python" in cmd.lower():   # 只結束本機助手，不動其他程式
            subprocess.run(["taskkill", "/PID", pid, "/F"], capture_output=True, creationflags=flags)
    for _ in range(10):
        if not is_running(port):
            return True
        time.sleep(0.3)
    return False


def start_helper():
    exe = sys.executable
    if exe.lower().endswith("python.exe"):
        exe = exe[:-10] + "pythonw.exe"
    args = [exe, os.path.join(HELPER_DIR, "server.py")]
    DETACHED, NEW_GROUP, BREAKAWAY, NO_WINDOW = 0x8, 0x200, 0x01000000, 0x08000000
    base = DETACHED | NEW_GROUP | NO_WINDOW
    try:   # 脫離 Chrome 的工作群組，Chrome 關掉啟動器時助手才不會跟著被關
        subprocess.Popen(args, cwd=HELPER_DIR, creationflags=base | BREAKAWAY, close_fds=True,
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except OSError:
        subprocess.Popen(args, cwd=HELPER_DIR, creationflags=base, close_fds=True,
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def main():
    if os.name == "nt":
        import msvcrt
        msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
        msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)
    try:
        msg = read_msg() or {}
        cfg = load_config()
        port = int(cfg.get("port", 8765))
        cmd = msg.get("cmd")
        if cmd == "start":
            if not is_running(port):
                start_helper()
                for _ in range(40):          # 最多等 20 秒讓助手開好
                    time.sleep(0.5)
                    port = int(load_config().get("port", 8765))   # 原本的埠被占用時，助手會換一個並記在設定檔
                    if is_running(port):
                        break
            send_msg({"ok": is_running(port), "port": port, "token": cfg["token"]})
        elif cmd == "restart":                 # 擴充功能更新後，把還在跑的舊版助手換成新版
            if is_running(port) and not stop_helper(port, cfg["token"]):
                send_msg({"ok": False, "error": "無法結束舊版本機助手，請在系統匣的紅色「T」圖示按右鍵 →「結束」，再重新開啟"})
                return
            start_helper()
            for _ in range(40):
                time.sleep(0.5)
                port = int(load_config().get("port", 8765))
                if is_running(port):
                    break
            send_msg({"ok": is_running(port), "port": port, "token": cfg["token"], "version": running_version(port)})
        elif cmd == "token":
            send_msg({"ok": True, "port": port, "token": cfg["token"], "running": is_running(port)})
        else:
            send_msg({"ok": False, "error": "unknown command"})
    except Exception as e:
        send_msg({"ok": False, "error": str(e)[:200]})


if __name__ == "__main__":
    main()
