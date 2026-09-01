#!/usr/bin/env bash
# =============================================================================
# Launcher da API Centria (Spring Boot) para o server-manager.
# Motivo: o Makefile do repo (espelho de aap/master) usa 'dev-api', nao 'run-api',
# e nao ha mvnw.cmd/bun no PATH — entao rodamos via Git Bash.
# IMPORTANTE: a API EXIGE JDK 21. JDK 24 quebra o Lombok 1.18.36
# (java.lang.ExceptionInInitializerError: TypeTag :: UNKNOWN).
# =============================================================================
# Sem 'set -u': o sdkman-init.sh e o .env podem referenciar variaveis nao-setadas.

# Java 21 via SDKMAN (preferido), com fallback pro Temurin 21 instalado via winget.
export SDKMAN_DIR="$HOME/.sdkman"
if [ -s "$SDKMAN_DIR/bin/sdkman-init.sh" ]; then
  # shellcheck disable=SC1091
  source "$SDKMAN_DIR/bin/sdkman-init.sh" || true
fi
if [ -z "${JAVA_HOME:-}" ] || ! "$JAVA_HOME/bin/java" -version >/dev/null 2>&1; then
  export JAVA_HOME="/c/Program Files/Eclipse Adoptium/jdk-21.0.11.10-hotspot"
fi
export PATH="$JAVA_HOME/bin:$PATH"

echo "[run-centria-api] JAVA_HOME=$JAVA_HOME"
"$JAVA_HOME/bin/java" -version

cd /d/aplicativos/centria || { echo "centria dir nao encontrado"; exit 1; }

# Carrega o .env (Cognito, Anthropic, Google, SERPRO, chave de criptografia, etc.)
set -a
# shellcheck disable=SC1091
[ -f .env ] && . ./.env
set +a

cd apps/backend-api || exit 1
# spring.devtools.restart.enabled=false: sem isso o DevTools roda a app num JVM
# FILHO (restartedMain) que sobrevive ao stop do orquestrador e fica zumbi segurando
# a 8091 -> proxima subida falha com "Port 8091 was already in use".
exec ./mvnw -q spring-boot:run -Dspring-boot.run.profiles=dev \
  -Dspring-boot.run.jvmArguments="-Dspring.devtools.restart.enabled=false"
