"""登記 Chrome（與 Edge）的「原生訊息」啟動器，讓擴充功能的「立即開啟」按鈕能啟動本機助手。
只寫入目前使用者的登錄機碼（HKCU），不需要系統管理員權限。加上 --remove 可取消登記。"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import EXTENSION_ID, HELPER_DIR, NATIVE_HOST_NAME, load_config  # noqa: E402

KEYS = ["Software\\Google\\Chrome\\NativeMessagingHosts\\" + NATIVE_HOST_NAME,
        "Software\\Microsoft\\Edge\\NativeMessagingHosts\\" + NATIVE_HOST_NAME]


def main():
    import winreg
    manifest = os.path.join(HELPER_DIR, "native-host.json")
    if "--remove" in sys.argv:
        for k in KEYS:
            try:
                winreg.DeleteKey(winreg.HKEY_CURRENT_USER, k)
            except OSError:
                pass
        print("已取消登記")
        return
    with open(manifest, "w", encoding="utf-8") as f:
        json.dump({
            "name": NATIVE_HOST_NAME,
            "description": "YT 字幕助手啟動器",
            "path": os.path.join(HELPER_DIR, "launcher.bat"),
            "type": "stdio",
            "allowed_origins": [f"chrome-extension://{EXTENSION_ID}/"],
        }, f, ensure_ascii=False, indent=2)
    for k in KEYS:
        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, k) as h:
            winreg.SetValueEx(h, "", 0, winreg.REG_SZ, manifest)
    load_config()   # 順便產生通行碼
    print("已登記「立即開啟」功能")


if __name__ == "__main__":
    main()
