@echo off
setlocal
rem Assure que npm est trouvé si le PATH du terminal ne contient pas Node.js
set "NODEJS_DIR=C:\Program Files\nodejs"
if exist "%NODEJS_DIR%\npm.cmd" set "PATH=%NODEJS_DIR%;%PATH%"

cd /d "%~dp0"

where npm >nul 2>&1
if errorlevel 1 (
  echo npm introuvable. Installe Node.js LTS depuis https://nodejs.org/
  echo ou ajoutez manuellement au PATH : C:\Program Files\nodejs
  exit /b 1
)

if not exist "node_modules\" (
  echo Installation des dependances...
  call npm install
  if errorlevel 1 exit /b 1
)

echo Demarrage du serveur de dev...
call npm run dev
