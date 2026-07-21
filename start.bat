@echo off
title Stream Notebook
cd /d "%~dp0"

REM The console defaults to a code page that mangles the emoji and box-drawing
REM characters the server prints, which looks like corruption to a first-time
REM user. 65001 is UTF-8.
chcp 65001 >nul 2>nul

echo.
echo   Stream Notebook
echo   ===============================================
echo.
echo   Starting up...
echo.

REM Running from inside the ZIP puts us in a temp folder where npm install and
REM the data/ folder both fail in confusing ways. Catch it before that happens.
echo %CD% | findstr /i /c:"\AppData\Local\Temp" >nul
if not errorlevel 1 (
    echo   ---------------------------------------------
    echo   This is still inside the ZIP file.
    echo   ---------------------------------------------
    echo.
    echo   Windows is running it from a temporary folder, and it
    echo   cannot save your notes there.
    echo.
    echo   To fix it:
    echo     1. Close this window.
    echo     2. Find the ZIP you downloaded.
    echo     3. Right-click it and choose "Extract All..."
    echo     4. Open the folder that appears and double-click start.bat again.
    echo.
    pause
    exit /b 1
)

where node >nul 2>nul
if errorlevel 1 (
    echo   ---------------------------------------------
    echo   Node.js needs installing first
    echo   ---------------------------------------------
    echo.
    echo   It's free, takes two minutes, and you'll never
    echo   have to open it.
    echo.
    echo     1. Go to    https://nodejs.org
    echo     2. Click the big green LTS download button.
    echo     3. Run the installer, clicking Next until it finishes.
    echo     4. Double-click start.bat again.
    echo.
    echo   Press any key to open nodejs.org...
    pause >nul
    start https://nodejs.org
    exit /b 1
)

REM First run only. npm's own output is a wall of text a novice reads as an
REM error, so it's hidden unless something actually goes wrong.
if not exist "node_modules" (
    echo   Setting up for the first time. This takes a minute or two -
    echo   it only happens once. Please don't close this window...
    echo.
    call npm install --no-audit --no-fund >"%TEMP%\stream-notebook-install.log" 2>&1
    if errorlevel 1 (
        echo   ---------------------------------------------
        echo   Setup didn't finish
        echo   ---------------------------------------------
        echo.
        echo   This is nearly always the internet connection dropping.
        echo.
        echo   Try:
        echo     1. Check you're online.
        echo     2. Double-click start.bat again.
        echo.
        echo   Still stuck? Turn off your VPN or antivirus briefly and
        echo   retry - they sometimes block the download.
        echo.
        echo   The technical details are in:
        echo   %TEMP%\stream-notebook-install.log
        echo   Send that file to whoever gave you this if you need a hand.
        echo.
        pause
        exit /b 1
    )
    echo   Done setting up.
    echo.
)

REM The server opens the dashboard itself once it knows which port it got.
node server.js
set EXITCODE=%errorlevel%

echo.
if not "%EXITCODE%"=="0" (
    echo   ---------------------------------------------
    echo   The notebook stopped unexpectedly
    echo   ---------------------------------------------
    echo.
    echo   Any red text above explains why. Two common causes:
    echo     - It's already running in another window - close that one.
    echo     - Antivirus blocked it - allow it and try again.
    echo.
    echo   Double-click start.bat to start it again.
) else (
    echo   Notebook stopped. Double-click start.bat to start it again.
)
echo.
pause
