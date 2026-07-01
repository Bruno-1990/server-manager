' ============================================================================
'  SERVER MANAGER - Central Contabil
'  Launcher OCULTO do app de bandeja (tray.ps1), sem janela de PowerShell.
'  Usado pela Tarefa Agendada 'ServerManager Tray' no logon (elevado).
' ============================================================================
Dim shell
Set shell = CreateObject("WScript.Shell")
shell.CurrentDirectory = "D:\aplicativos\server-manager"
' 0 = oculto ; True = manter a tarefa "Em execucao" enquanto a bandeja estiver ativa
shell.Run "powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""D:\aplicativos\server-manager\tray.ps1""", 0, True
