@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ==== 第一次設定 GitHub（只需要執行一次）====
echo.

where git >nul 2>nul
if errorlevel 1 (
  echo 找不到 Git，正在用 winget 安裝...
  winget install --id Git.Git -e --source winget --accept-package-agreements --accept-source-agreements
  echo.
  echo Git 安裝完成。請關閉這個視窗，再重新雙擊 setup-github.bat。
  pause
  exit /b 0
)
where gh >nul 2>nul
if errorlevel 1 (
  echo 找不到 GitHub CLI，正在用 winget 安裝...
  winget install --id GitHub.cli -e --source winget --accept-package-agreements --accept-source-agreements
  echo.
  echo GitHub CLI 安裝完成。請關閉這個視窗，再重新雙擊 setup-github.bat。
  pause
  exit /b 0
)

gh auth status >nul 2>nul
if errorlevel 1 (
  echo 接下來會打開瀏覽器登入 GitHub，照畫面指示完成即可。
  gh auth login --web --git-protocol https || goto :fail
)
gh auth setup-git || goto :fail

if not exist ".git" (
  git init -b main || goto :fail
)

rem 還沒設定 Git 的署名時，用 GitHub 帳號的不公開信箱
git config user.email >nul 2>nul
if errorlevel 1 (
  for /f "delims=" %%U in ('gh api user --jq .login') do set "GHUSER=%%U"
  for /f "delims=" %%I in ('gh api user --jq .id') do set "GHID=%%I"
  call git config user.name "%%GHUSER%%"
  call git config user.email "%%GHID%%+%%GHUSER%%@users.noreply.github.com"
)

git add -A
call :safety || goto :fail
git commit -q -m "初次發佈" || goto :fail

git remote get-url origin >nul 2>nul
if errorlevel 1 (
  gh repo create yt-subtitle-translator --private --source . --push || goto :fail
) else (
  git push -u origin main || goto :fail
)
echo.
echo 完成！專案已上傳到你 GitHub 帳號的私人 repo：yt-subtitle-translator
echo 之後要存檔時，雙擊 save.bat 就好。
pause
exit /b 0

:fail
echo.
echo 沒有完成，請把上面的訊息截圖保存。
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
