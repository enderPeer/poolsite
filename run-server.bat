@echo off
rem Startet den PoolSite-Server und schreibt Ausgaben in server.log.
rem Wird vom Watchdog (Aufgabenplanung) aufgerufen, wenn der Server nicht laeuft.
cd /d "%~dp0"
"C:\Program Files\nodejs\node.exe" server.js >> server.log 2>&1
