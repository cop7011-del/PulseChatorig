@echo off
setlocal
cd /d "%~dp0"
set PORT=4000
where node >nul 2>nul || (echo Node.js not found. Install Node.js first. & pause & exit /b 1)

start "PulseChat Server" /min cmd /c "node server/index.js"
timeout /t 2 /nobreak >nul

set "APPURL=http://localhost:%PORT%/pulse.html"
set "PROFILE=%~dp0data\edge-profile"

if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" (
  start "" "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" --app=%APPURL% --user-data-dir="%PROFILE%"
) else if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" (
  start "" "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" --app=%APPURL% --user-data-dir="%PROFILE%"
) else if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" (
  start "" "%ProgramFiles%\Google\Chrome\Application\chrome.exe" --app=%APPURL% --user-data-dir="%PROFILE%"
) else (
  start "" %APPURL%
)
