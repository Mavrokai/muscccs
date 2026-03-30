@echo off
setlocal
set "NODEJS_DIR=C:\Program Files\nodejs"
if exist "%NODEJS_DIR%\npm.cmd" set "PATH=%NODEJS_DIR%;%PATH%"

cd /d "%~dp0"

where npm >nul 2>&1
if errorlevel 1 (
  echo npm introuvable. Installe Node.js depuis https://nodejs.org/
  exit /b 1
)

if not exist "node_modules\" (
  echo Installation des dependances...
  call npm install
  if errorlevel 1 exit /b 1
)

echo Lancement Mass Protocol en fenetre bureau...
call npm run desktop
