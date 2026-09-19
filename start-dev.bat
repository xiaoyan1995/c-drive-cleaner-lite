@echo off
setlocal

set "APP_DIR=%~dp0"
cd /d "%APP_DIR%"

if not exist "package.json" (
  echo [ERROR] package.json not found in current directory.
  pause
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo [ERROR] npm is not available in PATH.
  pause
  exit /b 1
)

if /i "%~1"=="--check" (
  echo [OK] Environment check passed.
  exit /b 0
)

if not exist "node_modules" (
  echo [INFO] node_modules not found. Running npm install...
  call npm install
  if errorlevel 1 (
    echo [ERROR] npm install failed.
    pause
    exit /b 1
  )
)

echo [INFO] Starting development mode...
call npm run dev
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
  echo [ERROR] Dev process exited with code %EXIT_CODE%.
  pause
)

exit /b %EXIT_CODE%
