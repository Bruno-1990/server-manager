@echo off
:: ============================================================================
::  SERVER MANAGER - Central Contabil  (RUNNER DE SERVICO / auto-start)
::  Versao NAO-interativa do start.bat, usada pela Tarefa Agendada do Windows.
::  - Sem 'pause', sem auto-elevacao (a tarefa ja roda elevada) e sem abrir
::    navegador. Toda a saida vai para logs\service.log.
::  - Mantem o node server.mjs SEMPRE no ar (loop keep-alive: reinicia se cair).
::  ATENCAO: NAO adicionar a porta 8000 no kill de portas (container Docker).
::  Doc: DOCUMENTACAO.md
:: ============================================================================
chcp 65001 >nul 2>&1
title Server Manager (servico) - Central Contabil
cd /d "%~dp0"

set "LOGDIR=%~dp0logs"
if not exist "%LOGDIR%" mkdir "%LOGDIR%"
set "LOG=%LOGDIR%\service.log"

:: Rotaciona o log se passar de ~5 MB (guarda o anterior como .old)
if exist "%LOG%" for %%S in ("%LOG%") do if %%~zS GTR 5000000 move /Y "%LOG%" "%LOG%.old" >nul 2>&1

echo. >> "%LOG%"
echo ==================================================== >> "%LOG%"
echo [%date% %time%] Iniciando Server Manager (servico) >> "%LOG%"
echo ==================================================== >> "%LOG%"

:: --- Node presente? ---
where node >nul 2>&1
if errorlevel 1 (
    echo [%date% %time%] [ERRO] Node.js nao encontrado no PATH. Abortando. >> "%LOG%"
    exit /b 1
)

:: --- Libera portas 5176, 9000, 9001 (NAO inclui 8000 = container Docker) ---
echo [%date% %time%] Liberando portas 5176, 9000, 9001... >> "%LOG%"
for %%P in (5176 9000 9001) do (
    for /f "tokens=5" %%A in ('netstat -aon ^| findstr ":%%P " ^| findstr "LISTENING"') do (
        taskkill /F /PID %%A >nul 2>&1
    )
)

:: --- Firewall inbound TCP 9000 / 9001 ---
echo [%date% %time%] Configurando regras de firewall (9000 e 9001)... >> "%LOG%"
netsh advfirewall firewall delete rule name="Server Manager 9000" >nul 2>&1
netsh advfirewall firewall add rule name="Server Manager 9000" dir=in action=allow protocol=TCP localport=9000 >nul
netsh advfirewall firewall delete rule name="Server Manager 9001" >nul 2>&1
netsh advfirewall firewall add rule name="Server Manager 9001" dir=in action=allow protocol=TCP localport=9001 >nul

:: --- Docker Desktop + stack completo do webapp ---
echo [%date% %time%] Verificando Docker... >> "%LOG%"
docker info >nul 2>&1
if not errorlevel 1 goto dockerok
if not exist "C:\Program Files\Docker\Docker\Docker Desktop.exe" (
    echo [%date% %time%] [AVISO] Docker Desktop nao encontrado - pulando stack do webapp. >> "%LOG%"
    goto dockerdone
)
echo [%date% %time%] Docker desligado. Iniciando o Docker Desktop... >> "%LOG%"
start "" "C:\Program Files\Docker\Docker\Docker Desktop.exe"
set /a _tries=0
:waitdocker
timeout /t 3 >nul 2>&1
docker info >nul 2>&1
if not errorlevel 1 goto dockerok
set /a _tries+=1
if %_tries% lss 60 goto waitdocker
echo [%date% %time%] [AVISO] Docker nao subiu a tempo - o webapp em container pode nao iniciar. >> "%LOG%"
goto dockerdone

:dockerok
echo [%date% %time%] Docker OK. Subindo stack do webapp (api + workers + redis)... >> "%LOG%"
pushd "%~dp0..\webapp"
docker compose --profile sped --profile comparacao --profile nfse --profile gnre up -d >> "%LOG%" 2>&1
popd
echo [%date% %time%] Stack do webapp no ar. >> "%LOG%"

:dockerdone

:: --- Loop keep-alive do server.mjs (reinicia sempre que terminar) ---
:: SM_RUNNER=service avisa o server.mjs que ele roda sob keep-alive: o botao
:: "Reiniciar" so precisa sair (este loop religa) em vez de subir outra instancia.
set "SM_RUNNER=service"
:runloop
echo [%date% %time%] Iniciando node server.mjs... >> "%LOG%"
node server.mjs >> "%LOG%" 2>&1
echo [%date% %time%] [AVISO] server.mjs terminou (codigo %errorlevel%). Reiniciando em 5s... >> "%LOG%"
timeout /t 5 >nul 2>&1
goto runloop
