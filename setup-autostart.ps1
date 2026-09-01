# ============================================================================
#  SERVER MANAGER - setup de autostart (ELEVADO)
#   1) (Re)cria as 2 Tarefas Agendadas (logon, elevadas, sessao interativa)
#   2) Ativa o auto-login do Windows (para reboots sem ninguem logar)
#   3) Inicia os servicos agora
#  Chamado por instalar-autostart.bat (que auto-eleva). Log em logs\autostart-setup.log
# ============================================================================
$dir = 'D:\aplicativos\server-manager'
$logDir = Join-Path $dir 'logs'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Force -Path $logDir | Out-Null }
$log = Join-Path $logDir 'autostart-setup.log'
function L($m){ Add-Content -Path $log -Value ("[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $m) -ErrorAction SilentlyContinue; Write-Host $m }
L "== setup-autostart iniciado =="

$svcVbs  = Join-Path $dir 'run-service-hidden.vbs'
$trayVbs = Join-Path $dir 'tray-hidden.vbs'
$user    = "$env:USERDOMAIN\$env:USERNAME"
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
L "Elevado=$isAdmin  Usuario=$user"
if (-not $isAdmin) { L "ERRO: nao esta elevado. Abortando."; Write-Host "`nPressione ENTER..."; [void](Read-Host); exit 1 }

# ---- 1) Tarefas Agendadas ----
$okTasks = $false
try {
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
        -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
    $trigger   = New-ScheduledTaskTrigger -AtLogOn -User $user
    $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Highest
    foreach ($t in @(@('ServerManager - Central Contabil',$svcVbs), @('ServerManager Tray',$trayVbs))) {
        if (-not (Test-Path $t[1])) { throw "Nao encontrei $($t[1])" }
        $action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('"{0}"' -f $t[1]) -WorkingDirectory $dir
        Register-ScheduledTask -TaskName $t[0] -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
        L "Tarefa OK: $($t[0])"
    }
    $okTasks = $true
} catch { L "ERRO tarefas: $($_.Exception.Message)" }

# ---- 2) Auto-login ----
try {
    Write-Host ""
    $sec = Read-Host -AsSecureString "Digite a senha do Windows de $user (Enter em branco = pula auto-login)"
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
    $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    if ([string]::IsNullOrEmpty($plain)) {
        L "Auto-login: PULADO (senha em branco)"
    } else {
        $wl = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'
        Set-ItemProperty $wl 'AutoAdminLogon'    '1'             -Type String
        Set-ItemProperty $wl 'DefaultUserName'   $env:USERNAME   -Type String
        Set-ItemProperty $wl 'DefaultDomainName' $env:USERDOMAIN -Type String
        Set-ItemProperty $wl 'DefaultPassword'   $plain          -Type String
        $plain = $null
        L "Auto-login: ATIVADO para $user"
    }
} catch { L "ERRO auto-login: $($_.Exception.Message)" }

# ---- 3) Inicia agora ----
if ($okTasks) {
    try {
        Start-ScheduledTask -TaskName 'ServerManager - Central Contabil'
        Start-Sleep -Seconds 1
        Start-ScheduledTask -TaskName 'ServerManager Tray'
        L "Servicos iniciados (aguarde alguns segundos para 9000/9001 subirem)."
    } catch { L "ERRO start: $($_.Exception.Message)" }
}
L "== FIM =="
Write-Host ""
Write-Host "Concluido. Veja o resumo acima. Pressione ENTER para fechar." -ForegroundColor Green
[void](Read-Host)
