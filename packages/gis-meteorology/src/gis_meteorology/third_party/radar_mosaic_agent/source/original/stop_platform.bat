@echo off
setlocal
cd /d "%~dp0"

echo [INFO] Stopping Python process listening on port 5055...
powershell -NoProfile -Command "$connections = Get-NetTCPConnection -LocalPort 5055 -State Listen -ErrorAction SilentlyContinue; if ($connections) { $pids = $connections | Select-Object -ExpandProperty OwningProcess -Unique; foreach ($pid in $pids) { try { Stop-Process -Id $pid -Force -ErrorAction Stop; Write-Output ('[INFO] Stopped PID=' + $pid) } catch { Write-Output ('[WARN] Failed to stop PID=' + $pid) } } } else { Write-Output '[INFO] No listener found on port 5055.' }"

endlocal
