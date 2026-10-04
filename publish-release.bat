@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ==== 發佈下載版本（給別人下載用）====
if not exist ".git" (
  echo 還沒設定過 GitHub，請先雙擊 setup-github.bat。
  pause
  exit /b 1
)
git status --porcelain | findstr . >nul
if not errorlevel 1 (
  echo 還有沒存檔的修改，請先雙擊 save.bat 存檔，再執行本檔。
  pause
  exit /b 1
)
for /f "delims=" %%V in ('powershell -NoProfile -Command "(Get-Content -Raw -Encoding UTF8 extension\manifest.json | ConvertFrom-Json).version"') do set "VER=%%V"
if "%VER%"=="" (
  echo 讀不到版本號。
  pause
  exit /b 1
)
echo 版本：v%VER%
if not exist dist mkdir dist
rem 只打包已上傳到 GitHub 的檔案，不會包含你的設定、金鑰、快取或紀錄
git archive --format=zip --prefix=yt-subtitle-translator/ -o "dist\yt-subtitle-translator.zip" HEAD || goto :fail
gh release create "v%VER%" "dist\yt-subtitle-translator.zip" --title "v%VER%" --notes "下載 yt-subtitle-translator.zip，解壓縮後依照 README 的步驟安裝。" || goto :fail
echo.
echo 發佈完成！版本 v%VER%
pause
exit /b 0

:fail
echo.
echo 發佈沒有完成（同一個版本號已經發佈過時也會失敗），請把上面的訊息截圖保存。
pause
exit /b 1
