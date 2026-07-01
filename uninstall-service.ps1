# ============================================================================
#  SERVER MANAGER - Central Contabil
#  Remove as Tarefas Agendadas do auto-start (serviço + bandeja).
#
#  Uso (PowerShell COMO ADMINISTRADOR):
#     powershell -ExecutionPolicy Bypass -File .\uninstall-service.ps1
# ============================================================================
#Requires -RunAsAdministrator
$ErrorActionPreference = 'Stop'

$tasks = @('ServerManager - Central Contabil', 'ServerManager Tray')

foreach ($taskName in $tasks) {
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if (-not $task) {
        Write-Host "Tarefa '$taskName' nao esta instalada. Pulando." -ForegroundColor Yellow
        continue
    }
    try { Stop-ScheduledTask -TaskName $taskName } catch {}
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Host "OK: tarefa '$taskName' removida." -ForegroundColor Green
}

Write-Host "(O node server.mjs e a bandeja que ja estiverem rodando continuam ate a proxima parada/reboot.)"
