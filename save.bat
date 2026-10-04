@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion
cd /d "%~dp0"
echo ==== 存檔到 GitHub ====
if not exist ".git" (
  echo 還沒設定過 GitHub，請先雙擊 setup-github.bat。
  pause
  exit /b 1
)
git add -A
git diff --cached --quiet
if not errorlevel 1 (
  echo 沒有新的修改，不需要存檔。
  pause
  exit /b 0
)
call :safety || goto :fail

if exist ".commit-message.txt" (
  git commit -q -F ".commit-message.txt" || goto :fail
  del ".commit-message.txt"
) else (
  set "MSG="
  set /p "MSG=這次改了什麼（簡短說明，直接按 Enter 用「更新」）："
  if "!MSG!"=="" set "MSG=更新"
  git commit -q -m "!MSG!" || goto :fail
)
git push || goto :fail
echo.
echo 存檔完成！
pause
exit /b 0

:fail
echo.
echo 存檔沒有完成，請把上面的訊息截圖保存。
pause
exit /b 1

:safety
rem 檢查準備上傳的檔案裡有沒有金鑰、設定或紀錄；找到就取消暫存並中止
set "BAD="
for /f "delims=" %%F in ('git diff --cached --name-only') do (
  echo %%F| findstr /I /L /C:".env" /C:"config.json" /C:"history.json" /C:".log" /C:".key" /C:".pem" /C:"secret" /C:"password" /C:"credential" /C:"apikey" /C:"native-host.json" /C:".venv/" /C:"helper/models/" /C:"helper/cache/" >nul && (
    echo   [危險] %%F
    set "BAD=1"
  )
)
if defined BAD (
  git reset -q
  echo.
  echo 發現不應該上傳的檔案（上面標 [危險] 的），已取消這次存檔，什麼都沒有上傳。
  echo 請確認 .gitignore 有排除這些檔案後再試一次。
  exit /b 1
)
exit /b 0
