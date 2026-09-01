@echo off
:: ============================================================================
::  SERVER MANAGER - Instalar autostart (dois cliques)
::  Auto-eleva (UAC) e chama setup-autostart.ps1:
::    - (re)cria as Tarefas Agendadas de logon
::    - ativa o auto-login do Windows
::    - inicia os servicos agora
:: ============================================================================
title Instalar autostart - Server Manager

:: Auto-elevacao
net session >nul 2>&1
if errorlevel 1 (
    echo Solicitando privilegios de administrador...
    powershell -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-autostart.ps1"
