#!/usr/bin/env bash
# =============================================================================
# Launcher do frontend Centria (Vite/React) para o server-manager.
# Roda na porta 5180 (config do orquestrador) — o 5173 e usado por outro projeto.
# O vite.config.ts tem envDir '../..', entao o Vite le o .env da raiz do Centria
# sozinho (VITE_API_URL, VITE_COGNITO_*).
#
# Usamos o BUN (nao node): o node_modules e instalado pelo bun (store .bun/ com
# symlinks) e o node nao resolve essa store no Windows (ERR_MODULE_NOT_FOUND em
# deps transitivas como o rollup). O bun entende a propria store.
# =============================================================================
set -o pipefail

cd /d/aplicativos/centria/apps/web || { echo "apps/web nao encontrado"; exit 1; }

# Resolve o bun (nem sempre no PATH do processo herdado pelo orquestrador).
BUN="$(command -v bun 2>/dev/null)"
if [ -z "$BUN" ]; then
  for c in \
    "$HOME/.bun/bin/bun.exe" \
    "/c/Users/bruno/AppData/Local/Microsoft/WinGet/Links/bun.exe" \
    /c/Users/bruno/AppData/Local/Microsoft/WinGet/Packages/Oven-sh.Bun_*/bun-windows-x64/bun.exe ; do
    if [ -x "$c" ]; then BUN="$c"; break; fi
  done
fi
echo "[run-centria-web] bun=$BUN"

# --host 0.0.0.0: bind em todas as interfaces (sem isso o Vite escuta so em [::1]
# = localhost, e o acesso pelo IP da LAN 192.168.0.47:5180 da ERR_CONNECTION_REFUSED).
exec "$BUN" run dev -- --port 5180 --strictPort --host 0.0.0.0
