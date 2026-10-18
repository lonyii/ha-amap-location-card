@echo off
rem One-click publish wrapper for push.sh (Windows)
rem NOTE: this file MUST use CRLF line endings, otherwise cmd.exe mangles it.
chcp 65001 >nul
setlocal
cd /d "%~dp0"

set "BASH="
where bash >nul 2>nul
if not errorlevel 1 set "BASH=bash"
if not defined BASH if exist "%ProgramFiles%\Git\bin\bash.exe" set "BASH=%ProgramFiles%\Git\bin\bash.exe"
if not defined BASH if exist "%ProgramFiles(x86)%\Git\bin\bash.exe" set "BASH=%ProgramFiles(x86)%\Git\bin\bash.exe"
if not defined BASH if exist "%LOCALAPPDATA%\Programs\Git\bin\bash.exe" set "BASH=%LOCALAPPDATA%\Programs\Git\bin\bash.exe"
if not defined BASH for /d %%D in ("%USERPROFILE%\.workbuddy\binaries\PortableGit\versions\*") do if exist "%%D\bin\bash.exe" set "BASH=%%D\bin\bash.exe"

if not defined BASH goto nobash

"%BASH%" push.sh %*
set "RC=%ERRORLEVEL%"
echo.
pause
exit /b %RC%

:nobash
echo [x] bash not found. Please install Git for Windows: https://git-scm.com/download/win
echo.
pause
exit /b 1
