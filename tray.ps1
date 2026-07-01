# ============================================================================
#  SERVER MANAGER - Central Contabil
#  App de BANDEJA (system tray) ao lado do relogio.
#   - Bolinha VERDE = online (server.mjs responde na 9000) / VERMELHA = offline.
#   - Menu (botao direito): Abrir dashboard, Ligar, Desligar, Reiniciar, Sair.
#   - Controla o serviço pela Tarefa Agendada 'ServerManager - Central Contabil'.
#  Rodado oculto por tray-hidden.vbs (via Tarefa Agendada no logon, elevado).
# ============================================================================
# --- Esconde a janela de console (terminal) deste processo, se houver ---
if (-not ('Win32.NativeHide' -as [type])) {
    Add-Type -Namespace Win32 -Name NativeHide -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("kernel32.dll")]
public static extern System.IntPtr GetConsoleWindow();
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool ShowWindow(System.IntPtr hWnd, int nCmdShow);
'@
}
$__con = [Win32.NativeHide]::GetConsoleWindow()
if ($__con -ne [System.IntPtr]::Zero) { [Win32.NativeHide]::ShowWindow($__con, 0) | Out-Null }  # 0 = SW_HIDE

# --- Garante apartment STA (WinForms EXIGE). PowerShell 7 (pwsh) roda MTA e
#     quebra o NotifyIcon; nesse caso relanca no Windows PowerShell 5.1 (STA). ---
if ([System.Threading.Thread]::CurrentThread.GetApartmentState() -ne [System.Threading.ApartmentState]::STA) {
    Start-Process 'powershell.exe' -WindowStyle Hidden -ArgumentList @(
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', $PSCommandPath
    )
    return
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# --- Qualquer erro nao tratado: registra em log e mostra numa caixa de mensagem ---
$ErrorActionPreference = 'Stop'
trap {
    $msg = ($_ | Out-String)
    try {
        $ld = 'D:\aplicativos\server-manager\logs'
        if (-not (Test-Path $ld)) { New-Item -ItemType Directory -Force -Path $ld | Out-Null }
        Add-Content -Path (Join-Path $ld 'tray.log') -Value ("[" + (Get-Date) + "]`n" + $msg + "`n")
    } catch {}
    try { [System.Windows.Forms.MessageBox]::Show($msg, 'Server Manager Tray - ERRO') | Out-Null } catch {}
    break
}

$Global:SvcTask = 'ServerManager - Central Contabil'
$Global:HealthHost = '127.0.0.1'
$Global:HealthPort = 9000
$Global:Dashboard = 'http://192.168.0.47:9000'

# --- Cria um icone de bolinha colorida (16x16) ---
function New-DotIcon([System.Drawing.Color]$color) {
    $bmp = New-Object System.Drawing.Bitmap 16, 16
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.Clear([System.Drawing.Color]::Transparent)
    $border = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(60, 0, 0, 0))
    $g.FillEllipse($border, 1, 1, 14, 14)
    $brush = New-Object System.Drawing.SolidBrush $color
    $g.FillEllipse($brush, 2, 2, 12, 12)
    $g.Dispose(); $brush.Dispose(); $border.Dispose()
    $icon = [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
    $bmp.Dispose()
    return $icon
}

$Global:IconGreen = New-DotIcon ([System.Drawing.Color]::FromArgb(46, 204, 113))
$Global:IconRed   = New-DotIcon ([System.Drawing.Color]::FromArgb(231, 76, 60))
$Global:IconGray  = New-DotIcon ([System.Drawing.Color]::FromArgb(149, 165, 166))

# --- Testa se o server.mjs esta online (TCP connect rapido) ---
function Test-Online {
    try {
        $c = New-Object System.Net.Sockets.TcpClient
        $iar = $c.BeginConnect($Global:HealthHost, $Global:HealthPort, $null, $null)
        $ok = $iar.AsyncWaitHandle.WaitOne(600)
        $connected = $ok -and $c.Connected
        if ($connected) { $c.EndConnect($iar) }
        $c.Close()
        return $connected
    } catch { return $false }
}

# --- Roda schtasks oculto ---
function Invoke-Schtasks([string[]]$arguments) {
    try {
        Start-Process -FilePath 'schtasks.exe' -ArgumentList $arguments -WindowStyle Hidden -Wait -ErrorAction Stop
        return $true
    } catch { return $false }
}

function Start-Service-Mgr {
    Invoke-Schtasks @('/run', '/tn', $Global:SvcTask) | Out-Null
    $Global:Notify.ShowBalloonTip(2500, 'Server Manager', 'Ligando o serviço...', [System.Windows.Forms.ToolTipIcon]::Info)
}
function Stop-Service-Mgr {
    Invoke-Schtasks @('/end', '/tn', $Global:SvcTask) | Out-Null
    # Seguranca: encerra qualquer node preso nas portas 9000/9001
    foreach ($p in 9000, 9001) {
        $lines = netstat -aon | Select-String ":$p\s" | Select-String 'LISTENING'
        foreach ($l in $lines) {
            $procId = ($l -split '\s+')[-1]
            if ($procId -match '^\d+$') { Start-Process taskkill -ArgumentList '/F', '/PID', $procId -WindowStyle Hidden -Wait -ErrorAction SilentlyContinue }
        }
    }
    $Global:Notify.ShowBalloonTip(2500, 'Server Manager', 'Serviço desligado.', [System.Windows.Forms.ToolTipIcon]::Warning)
}
function Restart-Service-Mgr {
    $Global:Notify.ShowBalloonTip(2500, 'Server Manager', 'Reiniciando o serviço...', [System.Windows.Forms.ToolTipIcon]::Info)
    Invoke-Schtasks @('/end', '/tn', $Global:SvcTask) | Out-Null
    Start-Sleep -Milliseconds 900
    Invoke-Schtasks @('/run', '/tn', $Global:SvcTask) | Out-Null
}

# --- Atualiza icone/tooltip conforme status ---
function Update-Status {
    if (Test-Online) {
        $Global:Notify.Icon = $Global:IconGreen
        $Global:Notify.Text = 'Server Manager: ONLINE (9000/9001)'
    } else {
        $Global:Notify.Icon = $Global:IconRed
        $Global:Notify.Text = 'Server Manager: OFFLINE'
    }
}

# --- Menu de contexto ---
$menu = New-Object System.Windows.Forms.ContextMenuStrip

$miDash = $menu.Items.Add('Abrir dashboard')
$miDash.Add_Click({ Start-Process $Global:Dashboard })

$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null

$miOn = $menu.Items.Add('Ligar')
$miOn.Add_Click({ Start-Service-Mgr; Start-Sleep -Milliseconds 500; Update-Status })

$miOff = $menu.Items.Add('Desligar')
$miOff.Add_Click({ Stop-Service-Mgr; Start-Sleep -Milliseconds 500; Update-Status })

$miRestart = $menu.Items.Add('Reiniciar')
$miRestart.Add_Click({ Restart-Service-Mgr; Start-Sleep -Milliseconds 500; Update-Status })

$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null

$miExit = $menu.Items.Add('Sair (fecha só a bandeja)')
$miExit.Add_Click({
    $Global:Timer.Stop()
    $Global:Notify.Visible = $false
    $Global:Notify.Dispose()
    [System.Windows.Forms.Application]::Exit()
})

# --- Icone da bandeja ---
$Global:Notify = New-Object System.Windows.Forms.NotifyIcon
$Global:Notify.Icon = $Global:IconGray
$Global:Notify.Text = 'Server Manager: verificando...'
$Global:Notify.ContextMenuStrip = $menu
$Global:Notify.Visible = $true
# Duplo-clique abre o dashboard
$Global:Notify.Add_DoubleClick({ Start-Process $Global:Dashboard })

# --- Timer de status (a cada 4s) ---
$Global:Timer = New-Object System.Windows.Forms.Timer
$Global:Timer.Interval = 4000
$Global:Timer.Add_Tick({ Update-Status })
$Global:Timer.Start()

Update-Status
[System.Windows.Forms.Application]::Run((New-Object System.Windows.Forms.ApplicationContext))
