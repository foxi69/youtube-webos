@echo off
setlocal enabledelayedexpansion

echo Building YouTube Foxtended locally...
echo.

:: Check if node_modules exists. If not, run npm install (faster than ci)
if not exist "node_modules\" (
    echo [1/3] Installing dependencies...
    call npm install
    if !errorlevel! neq 0 (
        echo ERROR: npm install failed
        pause
        exit /b 1
    )
) else (
    echo [1/3] Dependencies already installed. Skipping...
)

echo [2/3] Building project...
call npm run build
if !errorlevel! neq 0 (
    echo ERROR: npm run build failed
    echo Press any key to close...
    pause >nul
    exit /b 1
)

echo [3/3] Creating .ipk package...
call npm run package
if !errorlevel! neq 0 (
    echo ERROR: npm run package failed
    echo Press any key to close...
    pause >nul
    exit /b 1
)

echo.
echo Build complete!