# Server Manager — Documentação de Manutenção

> Gerenciador de servidores locais da Central Contábil. Dashboard web que lista,
> inicia, para e monitora todos os apps/serviços da pasta `D:\aplicativos\`.
>
> **Antes de alterar qualquer coisa, leia este documento inteiro** — principalmente
> a seção [Ciclo de vida: Node vs Docker](#5-ciclo-de-vida-node-vs-docker), que
> contém a regra mais importante (nunca dar `taskkill` em porta de container).

---

## 1. Visão geral

- **Tipo:** servidor HTTP em Node puro (sem dependências — `package.json` tem `dependencies: {}`).
- **Porta(s):** escuta em **9000 e 9001** simultaneamente, bind em `0.0.0.0` (acessível na intranet).
- **Acesso intranet:** `http://192.168.0.47:9000` (ou `:9001`). Também `http://localhost:9000`.
- **O que faz:** lê o `port-registry.json`, mostra o status (online/offline via check de porta),
  e permite **Iniciar / Parar / Reiniciar / Ver logs** de cada serviço, além de detectar
  conflitos de porta e o estado do Docker.

### Arquivos

| Arquivo | Papel |
|---|---|
| `server.mjs` | Backend HTTP + toda a lógica (iniciar/parar/status/docker/SSE/métricas). **Núcleo.** |
| `port-registry.json` | **Fonte da verdade** dos apps e serviços (portas, comandos, cwd). |
| `start.bat` | Inicialização **manual** (duplo clique): auto-elevação, firewall, sobe Docker+webapp, abre o dashboard. |
| `public/index.html` | Estrutura do dashboard (topbar, hero, métricas, modal). |
| `public/app.js` | Frontend v2: SSE tempo real, render incremental, ícones, Chart.js, busca, logs. |
| `public/style.css` | Design v2 (glass, acento configurável, tokens). |
| `public/vendor/` | Libs/assets locais (offline): `chart.umd.min.js`, `inter-latin.woff2`, `jetbrains-mono-latin.woff2`. |
| `package.json` | Scripts `start`/`dev` (kill da porta 9000 + `node server.mjs`). |
| `run-service.bat` | **Auto-start.** Versão não-interativa do `start.bat` (sem UAC/pause/navegador) + loop keep-alive do `node server.mjs`. Roda via Tarefa Agendada. Ver §6b. |
| `run-service-hidden.vbs` | Lança o `run-service.bat` **sem janela** (segura a árvore de processos p/ permitir parar/reiniciar). |
| `tray.ps1` | **Ícone na bandeja** (NotifyIcon): bolinha verde/vermelha (status da 9000) + menu Ligar/Desligar/Reiniciar/Abrir/Sair. Ver §6b. |
| `tray-hidden.vbs` | Lança o `tray.ps1` sem janela de console. |
| `install-service.ps1` | Registra as 2 Tarefas Agendadas (serviço + bandeja) no logon, elevadas. Loga em `logs/install.log`. |
| `uninstall-service.ps1` | Remove as 2 Tarefas Agendadas do auto-start. |
| `logs/` | Saída do serviço (`service.log`), da bandeja (`tray.log`) e do instalador (`install.log`). |

---

## 2. Como rodar

**Modo normal:** dê duplo clique em `start.bat`. Ele:
1. **Auto-eleva** (UAC) — precisa de admin para mexer no firewall.
2. Libera as portas **5176, 9000, 9001** (mata processos presos). ⚠️ **Não** inclui a 8000 — ela é container Docker agora; matá-la quebraria o Docker.
3. Cria regras de **firewall** inbound para 9000 e 9001.
4. **Garante o Docker** (liga o Docker Desktop se estiver off, espera até ~90s) e sobe o **stack completo do webapp**.
5. Abre `http://192.168.0.47:9000` e `:9001` no navegador.
6. Roda `node server.mjs` (fica em primeiro plano — fechar a janela derruba o Manager).

**Modo dev (sem firewall/Docker):** `npm run dev` (usa `node --watch`, reinicia ao salvar).

**Modo serviço (auto-start no logon + bandeja):** roda sozinho ao ligar/logar e fica sempre
ativo, com ícone verde/vermelho na bandeja para Ligar/Desligar/Reiniciar. Ver **§6b**.

> **IP fixo:** o `192.168.0.47` está fixo no `start.bat` e no log do `server.mjs`.
> Se o IP da máquina mudar (DHCP), atualize nos dois lugares — ou reserve o IP no roteador.

---

## 3. `port-registry.json` — formato

Estrutura:
```json
{
  "apps": {
    "<appId>": {
      "nome": "Nome exibido",
      "diretorio": "../caminho",
      "servicos": {
        "<svcId>": { ...campos do serviço... }
      },
      "dependencias": []
    }
  },
  "infraCompartilhada": {
    "<id>": { ...serviço só-monitorado (sem comando)... }
  }
}
```

### Campos de um serviço

| Campo | Obrigatório | Descrição |
|---|---|---|
| `porta` | sim | Porta usada no check de status e nos links "Abrir". |
| `tipo` | sim | `frontend` \| `backend` \| `fullstack` \| `infra`. Afeta cor/links na UI. |
| `tecnologia` | sim | Texto livre exibido. **Se contém "Docker", o serviço é tratado como Docker** (ver §5). |
| `healthCheck` | sim | `http://...` (checa porta aberta) ou `tcp://localhost:PORTA`. Hoje o check é sempre por porta. |
| `comando` | sim* | Linha de comando para iniciar. Rodada **inteira no shell** (cmd.exe). *Infra compartilhada não tem comando (só monitorada). |
| `cwd` | sim* | Diretório de trabalho, **relativo a `server-manager/`** (ex.: `../webapp`). |
| `pararComando` | não | **Só para Docker.** Comando de parada (ex.: `docker compose ... stop`). Se ausente, é derivado do `comando`. |
| `env` | não | Objeto de variáveis de ambiente extras (ex.: `{ "PYTHONPATH": "." }`). |

### Exemplo — serviço Node (processo gerenciado)
```json
"frontend": {
  "porta": 5176,
  "tipo": "frontend",
  "tecnologia": "Vite + React",
  "healthCheck": "http://localhost:5176",
  "comando": "npm run dev:fe",
  "cwd": "../webapp/webapp-01"
}
```

### Exemplo — serviço Docker (ciclo de vida via compose)
```json
"backend": {
  "porta": 8000,
  "tipo": "backend",
  "tecnologia": "Stack Docker (API + workers + Redis)",
  "healthCheck": "http://localhost:8000/api/v1/health",
  "comando": "docker compose --profile sped --profile comparacao --profile nfse --profile gnre up -d",
  "pararComando": "docker compose --profile sped --profile comparacao --profile nfse --profile gnre stop",
  "cwd": "../webapp"
}
```

---

## 4. Endpoints da API (`server.mjs`)

| Rota | Método | Função |
|---|---|---|
| `/api/status` | GET | Status completo (todos apps + infra). Inclui `online`, `gerenciado`, `ehDocker`, `pid`. |
| `/api/docker` | GET | Estado do Docker: `{ instalado, rodando, versao? }`. Cache de 4s. |
| `/api/conflitos` | GET | Portas usadas por mais de um serviço. |
| `/api/portas` | GET | Mapa de todas as portas declaradas. |
| `/api/processo-porta?porta=N` | GET | Processo(s) que ocupam a porta (netstat+tasklist). |
| `/api/scan-portas` | GET | Varre todas as portas declaradas e diz quais estão em uso. |
| `/api/iniciar` | POST | `{appId, svcId}` → inicia o serviço. |
| `/api/parar` | POST | `{appId, svcId}` → para o serviço. |
| `/api/reiniciar` | POST | `{appId, svcId}` → para + espera 2s + inicia. |
| `/api/logs?appId=&svcId=` | GET | Últimas ~200 linhas de log do processo gerenciado. |
| `/api/matar-porta` | POST | `{porta}` → `taskkill` em quem ocupa a porta. ⚠️ **Não usar em porta Docker.** |
| `/api/stream` | GET (SSE) | **Tempo real.** Empurra `event: snapshot` a cada 2s com `{status, docker, conflitos, metricas}`. Heartbeat 15s. É a fonte primária do frontend. |
| `/api/logs/stream?appId=&svcId=` | GET (SSE) | **Logs ao vivo.** Node → diff do buffer; Docker → `docker compose ... logs -f`. Encerra o processo ao desconectar. |
| `/api/metricas` | GET | CPU%/RAM por container via `docker stats --no-stream`. Cache ~2s. |
| `/api/rebuild` | POST | `{appId, svcId}` (Docker) → `docker compose ... up -d --build` com **saída em streaming** (a UI lê o body via `fetch`/ReadableStream). |

---

## 4b. Frontend v2 (`public/`)

- **Tempo real:** o `app.js` abre **um `EventSource('/api/stream')`** e re-renderiza de forma
  **incremental por card** (compara o HTML de cada card; só toca no que mudou) → sem flicker
  e sem perder scroll. Não há mais polling.
- **Logs ao vivo:** `verLogs()` abre `EventSource('/api/logs/stream?...')`; o modal tem busca,
  autoscroll, quebra-linha, copiar, baixar e limpar.
- **Métricas:** `Chart.js` (vendor) desenha CPU% de cada container ao longo do tempo (buffer
  rolante de 30 pontos) + lista com barras de CPU/RAM.
- **Visual:** design glass com **acento configurável** (`--accent`, trocado pelos swatches no
  topbar e persistido em `localStorage` chave `sm-acento`). Ícones são SVG inline (Lucide) no
  objeto `ICONS` de `app.js`. Usa `color-mix()`/`backdrop-filter` (Edge/Chrome atuais).
- **Busca** (tecla `/`), **refresh** (tecla `r`), **fechar modal** (`Esc`). Filtra cards e a
  tabela de portas por nome/tecnologia/porta/status.
- **Offline:** fontes e Chart.js vêm de `public/vendor/` — **nada de CDN em runtime**. Para
  atualizar uma lib, baixe o arquivo novo para `vendor/` (1x, com internet).

> **Regra preservada:** serviços Docker continuam roteados para iniciar/parar/reiniciar via
> compose; o botão "Kill" some em portas de container; nada de `matarPorta` em Docker.

---

## 5. Ciclo de vida: Node vs Docker

> **ESTA É A PARTE MAIS IMPORTANTE.** O Manager trata dois tipos de serviço de
> formas diferentes. Misturar os dois quebra coisas.

Um serviço é considerado **Docker** quando `comando` ou `tecnologia` contém a string
`docker` (função `ehServicoDocker()` em `server.mjs`).

### Serviço Node/Python (processo gerenciado)
- **Iniciar:** mata quem estiver na porta (`matarProcessoNaPorta`), depois faz `spawn`
  do comando. O processo fica **rastreado** no `Map processos` (com PID e logs).
- **Parar:** `taskkill /PID <pid> /T /F` (mata a árvore).
- **Status:** `gerenciado: true` enquanto o processo vive; logs disponíveis.

### Serviço Docker (ciclo via compose)
- **Iniciar:** roda **só** `docker compose ... up -d`. **NÃO mata a porta antes.**
- **Parar:** roda `pararComando` (`docker compose ... stop`), não `taskkill`.
- **Status:** `gerenciado: false` (o `up -d` é detached e sai na hora; o container
  segue vivo por conta do Docker). Online é detectado pelo check de porta.

### ⚠️ Por que NUNCA dar `taskkill` em porta de container

No Windows, a porta publicada de um container (ex.: `0.0.0.0:8000`) é mantida pelo
**proxy do Docker Desktop** (`com.docker.backend`). Se o Manager der `taskkill` nessa
porta, ele mata o proxy do Docker → **derruba o Docker inteiro** e todos os containers.

Por isso, **para serviços Docker**:
- `iniciarServico` **pula** o bloco de matar-porta (`if (!ehDocker) { ... }`).
- A UI (`app.js`) sempre usa Iniciar/Parar/Reiniciar do Manager (compose), nunca os
  botões `matarPorta`/`adotarServico`.
- O botão **"Kill"** do Mapa de Portas é **escondido** em linhas cujo `tecnologia` contém "Docker".

Antes de iniciar um serviço Docker, o Manager também checa se o daemon está ligado
(`checarDocker()`); se não estiver, devolve erro acionável em vez de falhar silencioso,
e o dashboard mostra um **banner laranja** no topo.

---

## 6. Fluxo do `start.bat` (passo a passo)

```
1. chcp 65001            -> UTF-8 no console
2. net session           -> se não for admin, relança via PowerShell RunAs e sai
3. libera portas 5176/9000/9001 (NÃO 8000 — é Docker)
4. firewall: regras inbound 9000 e 9001 (idempotentes: delete + add)
5. Docker:
   - docker info  -> se OK, vai direto subir o stack
   - se off e Docker Desktop.exe existe -> liga e espera (30 tentativas x 3s = ~90s)
   - se não existe/não subiu -> AVISO e segue (o Manager sempre inicia)
   - sobe o webapp: pushd ..\webapp && docker compose --profile ... up -d
6. abre o dashboard (9000 e 9001) no navegador
7. node server.mjs       -> primeiro plano; fechar a janela = derrubar o Manager
```

> **Batch sem labels dentro de parênteses:** o bloco do Docker usa `goto`/labels
> (`:waitdocker`, `:dockerok`, `:dockerdone`) **fora** de blocos `( )` de propósito —
> labels dentro de parênteses quebram no cmd.exe.

---

## 6b. Auto-start no Windows (serviço + bandeja)

Além do `start.bat` (manual), o Manager sobe **sozinho no logon** e fica sempre ativo,
via **duas Tarefas Agendadas** do Windows — sem instalar nada além do Node.

### Arquitetura (por que Tarefa Agendada e não Serviço "de verdade")

Um Serviço clássico do Windows roda na **Session 0** (antes/independente do login) e
**não consegue** iniciar o **Docker Desktop** (app gráfico) nem mostrar os dev servers
que o Manager sobe. Por isso o auto-start usa **Tarefa Agendada no logon**, rodando na
**sessão interativa do usuário** (`CENTRAL\bruno`) com **privilégios elevados**
(`RunLevel Highest` → sem prompt de UAC, mas com direito a firewall/portas/Docker).

### As duas tarefas (criadas por `install-service.ps1`)

| Tarefa | Ação | Papel |
|---|---|---|
| `ServerManager - Central Contabil` | `wscript run-service-hidden.vbs` | Sobe o serviço: prep (portas/firewall/Docker/webapp) + `node server.mjs` em loop keep-alive. |
| `ServerManager Tray` | `wscript tray-hidden.vbs` | Sobe o ícone da bandeja (`tray.ps1`). |

Configuração de ambas: gatilho **AtLogOn** do usuário, principal **Interactive +
Highest**, `ExecutionTimeLimit = 0` (sem limite), `MultipleInstances = IgnoreNew`,
reinício automático se falhar.

### `run-service.bat` (o runner do serviço)

É o `start.bat` **sem** auto-elevação (a tarefa já é elevada), **sem** `pause` e **sem**
abrir navegador. Faz a mesma prep — libera 5176/9000/9001 (⚠️ nunca a 8000), cria
firewall 9000/9001, garante Docker Desktop e sobe o stack do webapp — e então entra num
**loop keep-alive**: `node server.mjs`; se o node cair, espera 5s e reinicia. Toda a
saída vai para `logs/service.log` (rotaciona em ~5 MB → `service.log.old`).

> **Por que o `.vbs` espera (`shell.Run ..., 0, True`):** mantém a tarefa "Em execução"
> com a árvore **wscript → cmd → node** presa a ela. Isso é o que permite **Desligar/
> Reiniciar** matarem a árvore inteira via `schtasks /end` (job object da tarefa).

### `tray.ps1` (bandeja)

`NotifyIcon` nativo (WinForms). Verifica a 9000 a cada 4s → **bolinha verde** (online) ou
**vermelha** (offline). Menu (botão direito): **Abrir dashboard**, **Ligar**
(`schtasks /run`), **Desligar** (`schtasks /end` + mata sobra nas portas), **Reiniciar**
(end + run), **Sair** (fecha só a bandeja). Detalhes de robustez:
- **STA obrigatório:** WinForms exige apartment STA. Como PowerShell 7 (pwsh) roda MTA e
  o ícone não aparece, o script **se relança no Windows PowerShell 5.1** (STA) se detectar
  MTA. As Tarefas usam `powershell` (5.1) de propósito.
- **Console oculto:** logo no início chama `ShowWindow(SW_HIDE)` (Win32) → nenhuma janela
  de terminal aparece, qualquer que seja o lançador.
- **Erros visíveis:** qualquer exceção abre um `MessageBox` e grava em `logs/tray.log`.

### Instalar / desinstalar

```powershell
# Instalar (precisa de ADMIN — a janela pede UAC e fica aberta mostrando o resultado):
powershell -Command "Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile -ExecutionPolicy Bypass -File D:\aplicativos\server-manager\install-service.ps1'"

# Desinstalar:
powershell -Command "Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile -ExecutionPolicy Bypass -File D:\aplicativos\server-manager\uninstall-service.ps1'"
```

O `install-service.ps1` registra as 2 tarefas, **inicia as duas na hora** (sem reboot) e
loga tudo em `logs/install.log`.

### Pontos de atenção

- **Depende de logon:** a tarefa dispara no **logon**. Se a máquina tem **autologin**,
  sobe sozinha ao ligar; senão, só depois que alguém logar. (Ajuste o autologin do Windows
  se quiser 100% sem intervenção.)
- **IP fixo `192.168.0.47`** continua valendo (usado no link do dashboard da bandeja).
- **Registro exige admin:** `install-service.ps1`/`uninstall-service.ps1` **precisam de
  elevação**; rodar sem admin falha com "Acesso negado".

---

## 7. Webapp — o stack Docker completo

O webapp roda o **backend inteiro em container** (1 serviço no Manager: `backend`) e o
**frontend em Vite local** (serviço `frontend`). Não existe service de frontend no compose.

- **Comando:** `docker compose --profile sped --profile comparacao --profile nfse --profile gnre up -d`
- **cwd:** `../webapp` (onde fica o `docker-compose.yml`)
- **Sobe 10 containers:** `redis`, `api` (8000), `worker`, `worker-sci-consolidado`,
  `worker-sci-portal-nacional`, `worker-sped`, `worker-sped-merge`,
  `worker-comparacao-planilhas`, `worker-comparacao-nfse`, `worker-gnre`.

Por que o stack completo (e não só o redis): os workers que delegam para engines
Python (SPED, comparação, NFSe, GNRE) **só funcionam 100% dentro do container** — fora
dele a tradução de path do `temp_jobs` só existe para o `worker-sci-consolidado`. Rodar
tudo em Docker garante todas as funcionalidades operantes.

> Mapa autoritativo de qual pasta TS ↔ qual service ↔ qual Dockerfile ↔ qual engine
> Python está no `docker-compose.yml` do webapp e na memória `webapp-architecture`.

### Rebuild de imagens (quando mexer no CÓDIGO dos workers)
O `up -d` **reusa a imagem buildada**. Se você alterar o código de um worker/api, use o
**botão "Rebuild" (ícone de martelo)** no card do serviço Docker — ele chama `/api/rebuild`
(`docker compose ... up -d --build`) e mostra o build ao vivo no modal. No terminal seria:
```
cd D:\aplicativos\webapp
docker compose --profile sped --profile comparacao --profile nfse --profile gnre up -d --build
```

---

## 8. Receitas de manutenção

### Adicionar um novo app/serviço Node
1. Adicione o bloco no `port-registry.json` (`comando`, `cwd` relativo, `porta`, `tipo`, `tecnologia`, `healthCheck`).
2. Reinicie o Manager. Pronto — ele aparece no dashboard.

### Adicionar um serviço Docker
1. Bloco no registro com `comando` (`docker compose ... up -d`) **e** `pararComando` (`... stop`).
2. Garanta que `tecnologia` contenha "Docker" (ou que o comando contenha `docker`) — é o que ativa o tratamento Docker-aware.
3. `cwd` apontando para a pasta do `docker-compose`.

### Mudar a(s) porta(s) do Manager
- `server.mjs`: constante `MANAGER_PORTS = [9000, 9001]`.
- `start.bat`: lista de kill, regras de firewall e URLs abertas.
- **Arquitetura:** cada porta é **um `http.Server` próprio** compartilhando o mesmo `handler`
  (um único Server NÃO escuta em 2 portas — a 2ª `listen()` falha). Porta ocupada é tolerada
  (loga `[AVISO]` e segue na outra).

### Mudar o IP da intranet
- `start.bat`: linhas `start http://...` e o `echo`.
- `server.mjs`: bloco de log no `server.listen`.

---

## 9. Problemas conhecidos / pontos de atenção

- **Centria `api` e `frontend` usam `make`** (`make run-api`, `make run-web`), mas o
  `make` **não está instalado** no Windows → esses dois botões falham. (A infra Docker
  do Centria já foi corrigida para não depender de make.) Para resolver: instalar `make`
  (ex.: via Chocolatey) **ou** trocar o comando pelos comandos diretos (Spring Boot / Vite).
- **Imagens Docker desatualizadas:** `up -d` não rebuilda — use o botão "Rebuild" (§7).
- **UAC a cada início:** o `start.bat` pede admin (firewall). Ao relançar elevado, o
  `cd /d "%~dp0"` garante o diretório correto.
- **Docker Desktop precisa existir/estar ligado** para os serviços em container.

---

## 10. Histórico de decisões (por quê)

- **2 portas (9000/9001):** redundância de acesso na intranet. **Um `http.Server` por porta**
  (a 2ª `listen()` no mesmo Server falha — bug corrigido).
- **Frontend v2 (tempo real + glass):** trocado o polling de 5s (que recriava todo o HTML e
  piscava) por SSE (`/api/stream`) + render incremental por card. Adicionados métricas de
  container (Chart.js), logs ao vivo, busca, acento configurável e rebuild. Libs vendorizadas
  em `public/vendor/` para funcionar offline na intranet (sem CDN).
- **Webapp 100% em Docker:** garantir que SPED/comparação/NFSe/GNRE funcionem (workers
  Python só rodam completos no container). Antes rodava `npm run dev:backend` (Node local)
  + só o `redis` em container, e várias features quebravam.
- **Manager Docker-aware (não taskkill em porta de container):** evita derrubar o Docker
  Desktop inteiro ao parar/reiniciar um serviço em container.
- **Comando rodado como string única no shell:** preserva caminhos com espaço/aspas e
  permite comandos compostos (ex.: `docker network create ... & docker compose up -d`).
