# PoolSite Watchdog — startet den Server neu, falls er nicht mehr antwortet.
# Wird von der Aufgabenplanung alle 2 Minuten und beim Anmelden ausgefuehrt.
$ErrorActionPreference = 'SilentlyContinue'
$proj = Split-Path -Parent $MyInvocation.MyCommand.Path
$log  = Join-Path $proj 'watchdog.log'

function Test-Server {
  try {
    $r = Invoke-WebRequest -Uri 'http://localhost:3000/api/health' -TimeoutSec 5 -UseBasicParsing
    return ($r.StatusCode -eq 200)
  } catch { return $false }
}

if (Test-Server) { exit 0 }   # Server ist gesund -> nichts tun

# Nur starten, wenn wirklich nichts auf Port 3000 lauscht (verhindert Doppelstart)
$listening = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
if ($listening) { exit 0 }

$ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
Add-Content -Path $log -Value "[$ts] Server nicht erreichbar - starte neu"
Start-Process -FilePath (Join-Path $proj 'run-server.bat') -WorkingDirectory $proj -WindowStyle Hidden
