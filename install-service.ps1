# ============================================================================
#  SERVER MANAGER - Central Contabil
#  Instala DUAS Tarefas Agendadas que sobem no LOGON do usuario, elevadas
#  (sem prompt de UAC), na sessao interativa:
#     1) 'ServerManager - Central Contabil' -> o serviço (run-service.bat)
#     2) 'ServerManager Tray'               -> o icone da bandeja (tray.ps1)
#
#  Uso (PowerShell COMO ADMINISTRADOR):
#     powershell -ExecutionPolicy Bypass -File .\install-service.ps1
# ============================================================================
$ErrorActionPreference = 'Stop'

$dir = 'D:\aplicativos\server-manager'
$logDir = Join-Path $dir 'logs'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Force -Path $logDir | Out-Null }
$installLog = Join-Path $logDir 'install.log'
try { Start-Transcript -Path $installLog -Force | Out-Null } catch {}

function Pause-End {
    Write-Host ""
    Write-Host "Pressione ENTER para fechar..." -ForegroundColor Cyan
    try { [void](Read-Host) } catch {}
}

try {
    # Confirma elevacao
    $isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    Write-Host "Elevado (admin): $isAdmin"
    if (-not $isAdmin) { throw "Esta janela NAO esta elevada. Rode como administrador." }

    $svcVbs  = Join-Path $dir 'run-service-hidden.vbs'
    $trayVbs = Join-Path $dir 'tray-hidden.vbs'
    $user    = "$env:USERDOMAIN\$env:USERNAME"
    Write-Host "Usuario alvo: $user"

    foreach ($f in @($svcVbs, $trayVbs)) {
        if (-not (Test-Path $f)) { throw "Nao encontrei: $f" }
    }

    $settings = New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -StartWhenAvailable `
        -RestartCount 999 `
        -RestartInterval (New-TimeSpan -Minutes 1) `
        -ExecutionTimeLimit ([TimeSpan]::Zero) `
        -MultipleInstances IgnoreNew

    $trigger   = New-ScheduledTaskTrigger -AtLogOn -User $user
    $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Highest

    function Register-One([string]$name, [string]$vbs) {
        $action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$vbs`"" -WorkingDirectory $dir
        Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger `
            -Principal $principal -Settings $settings -Force | Out-Null
        Write-Host "OK: tarefa '$name' registrada." -ForegroundColor Green
    }

    Register-One 'ServerManager - Central Contabil' $svcVbs
    Register-One 'ServerManager Tray'               $trayVbs

    Start-ScheduledTask -TaskName 'ServerManager - Central Contabil'
    Start-Sleep -Seconds 1
    Start-ScheduledTask -TaskName 'ServerManager Tray'

    Write-Host ""
    Write-Host "TUDO INSTALADO E INICIADO. Inicia no logon de $user." -ForegroundColor Green
    Write-Host "Bandeja (perto do relogio): bolinha verde = online."
    Write-Host "Dashboard: http://192.168.0.47:9000  e  http://192.168.0.47:9001"
}
catch {
    Write-Host ""
    Write-Host "FALHOU: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host $_.ScriptStackTrace -ForegroundColor DarkYellow
}
finally {
    try { Stop-Transcript | Out-Null } catch {}
    Pause-End
}
