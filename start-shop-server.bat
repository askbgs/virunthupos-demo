@echo off
REM Shop server without Docker: needs Node.js 20+ and PostgreSQL installed on this PC.
REM Settings are read from .env in this folder (DATABASE_URL, POS_MODE=local, CLOUD_URL, SYNC_TOKEN).
cd /d "%~dp0"
:loop
node --env-file=.env server\index.js
echo POS stopped. Restarting in 5 seconds... (close this window to stop)
timeout /t 5 >nul
goto loop
