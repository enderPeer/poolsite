@echo off
rem PoolSite: Server + kostenloser Cloudflare-Tunnel starten
rem Die oeffentliche URL steht im Tunnel-Fenster (https://....trycloudflare.com)
cd /d "%~dp0"
start "PoolSite Server (nicht schliessen)" cmd /k node server.js
timeout /t 2 /nobreak >nul
start "PoolSite Tunnel (URL hier ablesen)" cmd /k ""C:\Program Files (x86)\cloudflared\cloudflared.exe" tunnel --url http://localhost:3000"
echo Beide Fenster offen lassen. Die App laeuft lokal auf http://localhost:3000
pause
