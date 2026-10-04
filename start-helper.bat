@echo off
chcp 65001 >nul
cd /d "%~dp0helper"
echo ==== YT 字幕助手 ====
if not exist ".venv\ytsub-ok.txt" (
  call :install
  if errorlevel 1 goto :fail
)
".venv\Scripts\python.exe" setup_native.py
start "" ".venv\Scripts\pythonw.exe" "%~dp0helper\server.py"
echo.
echo 本機助手已在背景啟動：螢幕右下角系統匣會出現紅色「T」字樣圖示。
echo 這個視窗 5 秒後自動關閉。
timeout /t 5 >nul
exit /b 0

:install
echo 第一次使用，正在安裝需要的元件（只需一次，約需 5～15 分鐘）...
set "PY="
where py >nul 2>nul && py -3.12 -V >nul 2>nul && set "PY=py -3.12"
if not defined PY where py >nul 2>nul && py -3 -V >nul 2>nul && set "PY=py -3"
if not defined PY where python >nul 2>nul && set "PY=python"
if not defined PY (
  echo 找不到 Python。請先到 https://www.python.org/downloads/ 安裝 Python 3.12，
  echo 安裝時記得勾選 "Add python.exe to PATH"，然後重新執行本檔。
  exit /b 1
)
echo 使用 %PY%
if not exist .venv (
  %PY% -m venv .venv || exit /b 1
)
".venv\Scripts\python.exe" -m pip install --upgrade pip
".venv\Scripts\python.exe" -m pip install -r requirements.txt || exit /b 1
if exist "..\..\VoiceType\.venv\Lib\site-packages\nvidia\cublas" (
  echo 找到 VoiceType 的顯示卡元件，直接共用，不重複下載。
) else (
  echo 安裝 NVIDIA 顯示卡元件（約 1GB）...
  ".venv\Scripts\python.exe" -m pip install -r requirements-gpu.txt || echo 顯示卡元件安裝失敗，之後會改用 CPU（速度較慢）。
)
echo 準備語音模型...
".venv\Scripts\python.exe" prepare_model.py || exit /b 1
echo ok> ".venv\ytsub-ok.txt"
echo 安裝完成！
exit /b 0

:fail
echo.
echo 安裝沒有完成，請把上面的錯誤訊息截圖保存。修正後再雙擊本檔即可從中斷處繼續。
pause
exit /b 1
