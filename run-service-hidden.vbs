' ============================================================================
'  SERVER MANAGER - Central Contabil
'  Launcher OCULTO: inicia run-service.bat sem mostrar janela de console.
'  Usado pela Tarefa Agendada (wscript.exe run-service-hidden.vbs).
' ============================================================================
Dim shell
Set shell = CreateObject("WScript.Shell")
shell.CurrentDirectory = "D:\aplicativos\server-manager"
' 0 = janela oculta ; True = esperar (mantem a tarefa "Em execucao" com a arvore
' de processos wscript->cmd->node presa a ela, para poder parar/reiniciar limpo).
shell.Run "cmd /c ""D:\aplicativos\server-manager\run-service.bat""", 0, True
