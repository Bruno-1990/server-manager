#!/usr/bin/env bash
# =============================================================================
# Launcher do task-orchestrator Centria (Python) para o server-manager.
# Consome a fila SQS do LocalStack (aap-processing-prod) e processa as tasks
# de background (INGEST_FILES, PARSE_*, APPLY_RULES, ...). Health na 8092.
#
# Pre-requisito: venv Windows em apps/backend-task-orchestrator/.venv
#   (python -m venv .venv && .venv/Scripts/python -m pip install -r requirements.txt).
# O proprio main.py carrega o .env local do orchestrator + o .env da raiz (fallback),
# de onde vem AAP_SQS_QUEUE_URL / endpoint do LocalStack.
# =============================================================================
set -o pipefail

cd /d/aplicativos/centria/apps/backend-task-orchestrator || { echo "orchestrator dir nao encontrado"; exit 1; }

PY=".venv/Scripts/python.exe"
if [ ! -x "$PY" ]; then
  echo "[run-centria-orchestrator] venv nao encontrado em $PY"
  echo "  rode: python -m venv .venv && .venv/Scripts/python.exe -m pip install -r requirements.txt"
  exit 1
fi

echo "[run-centria-orchestrator] iniciando sqs-listen (health :8092)"
exec "$PY" main.py sqs-listen
