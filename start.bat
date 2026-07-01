@echo off
:: ============================================================================
::  SERVER MANAGER - Central Contabil  (inicializacao)
::  Doc completa: DOCUMENTACAO.md  (LEIA antes de alterar)
::  Fluxo: auto-eleva (UAC) -> libera portas -> firewall 9000/9001
::         -> garante Docker e sobe o stack do webapp -> abre dashboard -> node
::  ATENCAO: NAO adicionar a porta 8000 no kill de portas (e container Docker;
::           matar a porta derruba o proxy do Docker Desktop).
:: ============================================================================
chcp 65001 >nul 2>&1
title Server Manager - Central Contabil

:: Auto-elevacao: precisa de admin para criar regras de firewall
net session >nul 2>&1
if errorlevel 1 (
    echo Solicitando privilegios de administrador...
    powershell -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

echo.
echo  ========================================
echo   Server Manager - Central Contabil
echo  ========================================
echo.

cd /d "%~dp0"

:: Verifica Node.js
where node >nul 2>&1
if errorlevel 1 (
    echo [ERRO] Node.js nao encontrado no PATH.
    pause
    exit /b 1
)

:: Libera as portas do Manager e do frontend Vite (NAO inclui 8000: agora e container Docker)
echo Liberando portas 5176, 9000 e 9001...
for %%P in (5176 9000 9001) do (
    for /f "tokens=5" %%A in ('netstat -aon ^| findstr ":%%P " ^| findstr "LISTENING"') do (
        taskkill /F /PID %%A >nul 2>&1
    )
)
echo Portas liberadas.
echo.

:: Libera as portas 9000 e 9001 no Firewall do Windows (inbound TCP)
echo Configurando regras de firewall (9000 e 9001)...
netsh advfirewall firewall delete rule name="Server Manager 9000" >nul 2>&1
netsh advfirewall firewall add rule name="Server Manager 9000" dir=in action=allow protocol=TCP localport=9000 >nul
netsh advfirewall firewall delete rule name="Server Manager 9001" >nul 2>&1
netsh advfirewall firewall add rule name="Server Manager 9001" dir=in action=allow protocol=TCP localport=9001 >nul
echo Firewall configurado.
echo.

:: ── Docker: garantir o daemon e subir o stack completo do webapp ──
echo Verificando Docker...
docker info >nul 2>&1
if not errorlevel 1 goto dockerok
if not exist "C:\Program Files\Docker\Docker\Docker Desktop.exe" (
    echo [AVISO] Docker Desktop nao encontrado - pulando stack do webapp.
    goto dockerdone
)
echo Docker desligado. Iniciando o Docker Desktop...
start "" "C:\Program Files\Docker\Docker\Docker Desktop.exe"
set /a _tries=0
:waitdocker
timeout /t 3 >nul 2>&1
docker info >nul 2>&1
if not errorlevel 1 goto dockerok
set /a _tries+=1
if %_tries% lss 30 goto waitdocker
echo [AVISO] Docker nao subiu a tempo - o webapp em container pode nao iniciar.
goto dockerdone

:dockerok
echo Docker OK. Subindo stack do webapp (api + workers + redis)...
pushd "%~dp0..\webapp"
docker compose --profile sped --profile comparacao --profile nfse --profile gnre up -d
popd
echo Stack do webapp no ar.

:dockerdone
echo.

echo Iniciando Server Manager...
echo Dashboard: http://192.168.0.47:9000  e  http://192.168.0.47:9001
echo.

start http://192.168.0.47:9000
start http://192.168.0.47:9001
node server.mjs

pause
