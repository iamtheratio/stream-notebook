@echo off
title Stream Notebook
cd /d "%~dp0"

echo.
echo   Stream Notebook
echo   ===============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
    echo   [!] Node.js is not installed.
    echo.
    echo   Download the LTS installer from https://nodejs.org
    echo   Run it, accept the defaults, then double-click this file again.
    echo.
    pause
    exit /b 1
)

REM First run only - installs dependencies. Takes a minute or two.
if not exist "node_modules" (
    echo   First run - installing. This takes a minute...
    echo.
    call npm install
    if errorlevel 1 (
        echo.
        echo   [!] Install failed. Check your internet connection and try again.
        echo.
        pause
        exit /b 1
    )
    echo.
)

REM Open the dashboard once the server has had a moment to bind the port.
start "" /b cmd /c "timeout /t 3 >nul && start http://localhost:8765"

node server.js

echo.
echo   Server stopped.
pause
