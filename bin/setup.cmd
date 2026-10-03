@echo off
REM =============================================================================
REM YuanCode setup script (Windows cmd.exe)
REM
REM Usage:
REM     bin\setup                  REM full setup with interactive init wizard
REM     bin\setup --no-init        REM install deps + .env only
REM     bin\setup --skip-install   REM init wizard only
REM =============================================================================
setlocal enabledelayedexpansion

set "SCRIPT_DIR=%~dp0"
pushd "%SCRIPT_DIR%.." >nul
set "PROJECT_ROOT=%CD%"
popd >nul
cd /d "%PROJECT_ROOT%"

set "SKIP_INSTALL=0"
set "NO_INIT=0"
set "HELP=0"

:parse_args
if "%~1"=="" goto :after_parse
if /i "%~1"=="--skip-install" ( set "SKIP_INSTALL=1" & shift & goto :parse_args )
if /i "%~1"=="--no-init"       ( set "NO_INIT=1"     & shift & goto :parse_args )
if /i "%~1"=="-h"               ( set "HELP=1"        & shift & goto :parse_args )
if /i "%~1"=="--help"           ( set "HELP=1"        & shift & goto :parse_args )
echo [ERROR] Unknown option: %~1
set "HELP=1"
shift
goto :parse_args

:after_parse
if "%HELP%"=="1" goto :show_help

echo.
echo ==^> YuanCode setup
echo [info] Project root: %PROJECT_ROOT%

REM ---- 1. Node version ----
echo.
echo ==^> [1/4] Node version check
where node >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node is not installed. Please install Node 20.10+ first.
    exit /b 1
)
for /f "delims=" %%v in ('node -v') do set "NODE_VERSION=%%v"
set "NODE_VERSION=%NODE_VERSION:v=%"
echo [ok] Node %NODE_VERSION% found

REM crude semver check: require major>=20 and minor>=10
for /f "tokens=1,2 delims=." %%a in ("%NODE_VERSION%") do (
    set "MAJOR=%%a"
    set "MINOR=%%b"
)
if %MAJOR% LSS 20 (
    echo [ERROR] Node %NODE_VERSION% is below required 20.10
    exit /b 1
)
if %MAJOR% EQU 20 if %MINOR% LSS 10 (
    echo [ERROR] Node %NODE_VERSION% is below required 20.10
    exit /b 1
)
echo [ok] Node version satisfies ^>=20.10

REM ---- 2. pnpm ----
echo.
echo ==^> [2/4] pnpm
where pnpm >nul 2>&1
if errorlevel 1 (
    echo [warn] pnpm not found, installing via npm...
    where npm >nul 2>&1
    if errorlevel 1 (
        echo [ERROR] npm not found. Install pnpm manually: npm i -g pnpm
        exit /b 1
    )
    call npm install -g pnpm@10
    if errorlevel 1 (
        echo [ERROR] pnpm install failed
        exit /b 1
    )
) else (
    for /f "delims=" %%v in ('pnpm -v') do echo [ok] pnpm %%v found
)

REM ---- 3. Install ----
echo.
echo ==^> [3/4] Install dependencies
if "%SKIP_INSTALL%"=="0" (
    if exist node_modules (
        echo [info] node_modules exists, running pnpm install --frozen-lockfile
        call pnpm install --frozen-lockfile
        if errorlevel 1 call pnpm install
    ) else (
        call pnpm install
        if errorlevel 1 (
            echo [ERROR] pnpm install failed
            exit /b 1
        )
    )
    echo [ok] Dependencies installed
) else (
    echo [info] Skipping install (--skip-install)
)

REM ---- 4. .env ----
echo.
echo ==^> [4/4] .env file
if exist .env (
    echo [ok] .env already exists
) else (
    if exist .env.example (
        copy /Y .env.example .env >nul
        echo [ok] .env created from .env.example
        echo [info] Edit .env or run `yuancode init`
    ) else (
        echo [warn] .env.example not found, skipping
    )
)

REM ---- 5. Init ----
if "%NO_INIT%"=="0" (
    echo.
    echo ==^> Init wizard
    where yuancode >nul 2>&1
    if not errorlevel 1 (
        call yuancode init
    ) else (
        if exist "%PROJECT_ROOT%\bin\yuancode.mjs" (
            call node "%PROJECT_ROOT%\bin\yuancode.mjs" init
        ) else (
            echo [warn] Cannot locate yuancode binary, skipping init wizard
        )
    )
) else (
    echo [info] Skipping init wizard (--no-init)
)

echo.
echo ==^> Done!
echo YuanCode is ready.
echo Next steps:
echo     cd %PROJECT_ROOT%
echo     node bin\yuancode.mjs doctor
echo     node bin\yuancode.mjs init
echo     node bin\yuancode.mjs
exit /b 0

:show_help
echo YuanCode setup
echo.
echo Options:
echo     --skip-install    Skip `pnpm install`
echo     --no-init         Skip the interactive init wizard
echo     -h, --help        Show this message
exit /b 0
