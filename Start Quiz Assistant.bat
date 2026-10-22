@echo off
rem ==========================================================================
rem  AI Browser Learning Assistant - one-click setup and start (Windows)
rem
rem  Double-click this file. The first run installs everything, builds the
rem  extension and the backend, creates server\.env, and opens Chrome's
rem  extensions page. Every run then starts the backend in this window -
rem  keep it open while you use the extension; close it to stop.
rem
rem  Options:  "Start Quiz Assistant.bat" rebuild   - reinstall and rebuild
rem ==========================================================================
setlocal EnableExtensions
cd /d "%~dp0"
title AI Browser Learning Assistant
set "ROOT=%CD%"
set "DIST=%ROOT%\extension\dist"
set "PORT=3000"

echo.
echo  AI Browser Learning Assistant
echo  =============================
echo.

rem --- 1. Node.js 20 or newer ----------------------------------------------
where node >nul 2>nul
if errorlevel 1 (
  echo  [!] Node.js is not installed.
  echo      Install the LTS version from https://nodejs.org, then run this file again.
  start "" "https://nodejs.org/en/download"
  goto :fail
)
for /f "delims=" %%v in ('node -p "process.versions.node.split('.')[0]"') do set "NODE_MAJOR=%%v"
if %NODE_MAJOR% LSS 20 (
  echo  [!] Node.js 20 or newer is needed; this machine has version %NODE_MAJOR%.
  echo      Install the LTS version from https://nodejs.org, then run this file again.
  start "" "https://nodejs.org/en/download"
  goto :fail
)
echo  [ok] Node.js %NODE_MAJOR%

rem --- 2. Dependencies --------------------------------------------------------
set "FIRST_RUN="
if /i "%~1"=="rebuild" set "FIRST_RUN=1"
if not exist "node_modules\" set "FIRST_RUN=1"
if not exist "%DIST%\manifest.json" set "FIRST_RUN=1"
if not exist "server\dist\index.js" set "FIRST_RUN=1"

if defined FIRST_RUN (
  echo  [..] Installing dependencies - the first time takes a few minutes...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo  [!] npm install failed. Check your internet connection and try again.
    goto :fail
  )
  echo  [ok] Dependencies installed

  rem --- 3. Build ----------------------------------------------------------
  echo  [..] Building the backend and the extension...
  call npm run build
  if errorlevel 1 (
    echo  [!] The build failed - see the messages above.
    goto :fail
  )
  echo  [ok] Built
) else (
  echo  [ok] Already installed and built  ^(run with "rebuild" to redo it^)
)

rem --- 4. Backend configuration -------------------------------------------
if not exist "server\.env" (
  copy /y "server\.env.example" "server\.env" >nul
  echo  [ok] Created server\.env
  echo       No API key is needed in it: enter your own key in the extension's
  echo       Settings, under AI provider.
) else (
  echo  [ok] server\.env found
)
rem The backend's port, as server\.env sets it.
for /f "tokens=2 delims==" %%a in ('findstr /b /c:"PORT=" "server\.env"') do (
  for /f "tokens=1" %%b in ("%%a") do set "PORT=%%b"
)

rem --- 5. First run: help load the extension into Chrome ------------------
if defined FIRST_RUN (
  echo.
  echo  ------------------------------------------------------------------
  echo   Load the extension into Chrome ^(one time only^):
  echo.
  echo     1. On the Extensions page that opens, turn ON "Developer mode"
  echo        ^(top right^).
  echo     2. Click "Load unpacked" and choose this folder
  echo        ^(its path is already on your clipboard - just paste it^):
  echo.
  echo          "%DIST%"
  echo.
  echo     3. Click the extension's icon, then Options - Settings - AI provider:
  echo        pick a provider, paste your API key, click "Test provider",
  echo        then "Save changes".
  echo.
  echo   After rebuilding, press the reload button on the extension's card.
  echo  ------------------------------------------------------------------
  echo.
  <nul set /p "=%DIST%" | clip
  call :open_extensions_page
  explorer "%DIST%"
)

rem --- 6. Start the backend -------------------------------------------------
curl -s -o nul --max-time 2 "http://127.0.0.1:%PORT%/api/health" >nul 2>nul
if not errorlevel 1 (
  echo  [ok] A backend is already running on port %PORT% - nothing to start.
  echo       Close its window to stop it.
  goto :done
)
netstat -ano | findstr /r /c:":%PORT% .*LISTENING" >nul
if not errorlevel 1 (
  echo  [!] Another program is already using port %PORT%.
  echo      Close it, or set PORT=3001 in server\.env and change "Backend URL"
  echo      in the extension's Settings to http://127.0.0.1:3001.
  goto :fail
)

echo.
echo  [..] Starting the backend on http://127.0.0.1:%PORT%
echo       Keep this window open while you use the extension.
echo       Close it ^(or press Ctrl+C^) to stop.
echo.
call npm start --workspace server
echo.
echo  The backend has stopped.
goto :done

rem --------------------------------------------------------------------------
:open_extensions_page
rem Chrome opens chrome:// pages only when it is given one directly.
for %%p in (
  "%ProgramFiles%\Google\Chrome\Application\chrome.exe"
  "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
  "%LocalAppData%\Google\Chrome\Application\chrome.exe"
) do (
  if exist %%p (
    start "" %%p "chrome://extensions"
    exit /b 0
  )
)
echo  Open Chrome and go to chrome://extensions
exit /b 0

:fail
echo.
pause
exit /b 1

:done
echo.
pause
exit /b 0
