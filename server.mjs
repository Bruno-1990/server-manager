/**
 * SERVER MANAGER — Central Contábil
 * Dashboard para iniciar/parar/monitorar os serviços de D:\aplicativos\.
 *
 * >>> LEIA D:\aplicativos\server-manager\DOCUMENTACAO.md ANTES DE ALTERAR <<<
 *
 * Pontos-chave:
 *  - Escuta em 9000 e 9001 (0.0.0.0). Fonte da verdade dos serviços: port-registry.json.
 *  - Dois tipos de serviço, tratados de formas diferentes (ver ehServicoDocker):
 *      • Node/Python: spawn rastreado + taskkill para parar.
 *      • Docker:      'docker compose up -d' / 'stop'. NUNCA taskkill na porta —
 *                     a porta publicada pertence ao proxy do Docker Desktop, e
 *                     matá-la derruba o Docker inteiro.
 *  - Comando é executado como STRING ÚNICA no shell (preserva aspas/espaços e
 *    permite comandos compostos com '&').
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { exec, spawn } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MANAGER_PORTS = [9000, 9001];
const MANAGER_PORT = MANAGER_PORTS[0]; // porta principal (usada em URLs/logs)

// Como o Manager foi iniciado:
//  • "service": run-service.bat rodou o node dentro de um loop keep-alive
//    (ao sair, o .bat mata as portas e reinicia o node em ~5s). Detectado pela
//    env SM_RUNNER que o run-service.bat define antes de subir o node.
//  • standalone: node/npm/start.bat — ao sair NÃO volta sozinho.
const SOB_RUNNER = process.env.SM_RUNNER === "service";
// Nome da Tarefa Agendada (ver setup-autostart.ps1). 'schtasks /End' para limpo a
// árvore wscript→cmd→node SEM disparar o restart-on-failure da tarefa.
const TASK_NAME = "ServerManager - Central Contabil";

// ─── Evitar que erros não tratados derrubem o processo ───
process.on("uncaughtException", (err) => {
  console.error("[ERRO FATAL] uncaughtException:", err.message);
  console.error(err.stack);
});
process.on("unhandledRejection", (reason) => {
  console.error("[ERRO] unhandledRejection:", reason);
});

// ─── Carregar registro de portas ───
function carregarRegistro() {
  const raw = fs.readFileSync(path.join(__dirname, "port-registry.json"), "utf8");
  return JSON.parse(raw);
}

// ─── Estado dos processos gerenciados ───
const processos = new Map(); // chave: "appId:servicoId" → { proc, status, logs[] }

// ─── Checar se porta TCP está em uso ───
function checarPorta(porta) {
  return new Promise((resolve) => {
    // Tenta IPv4 primeiro, depois IPv6 se falhar
    const tentarConectar = (host, fallback) => {
      const sock = new net.Socket();
      sock.setTimeout(1500);
      sock.once("connect", () => {
        sock.destroy();
        resolve(true);
      });
      sock.once("timeout", () => {
        sock.destroy();
        if (fallback) tentarConectar(fallback, null);
        else resolve(false);
      });
      sock.once("error", () => {
        sock.destroy();
        if (fallback) tentarConectar(fallback, null);
        else resolve(false);
      });
      sock.connect(porta, host);
    };
    tentarConectar("127.0.0.1", "::1");
  });
}

// ─── Health check HTTP ───
async function checarHealthHttp(url) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: 3000 }, (res) => {
      resolve(res.statusCode >= 200 && res.statusCode < 500);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

// ─── Health check geral ───
async function checarHealth(servico) {
  const hc = servico.healthCheck;
  if (hc.startsWith("tcp://")) {
    const porta = parseInt(hc.split(":").pop());
    return checarPorta(porta);
  }
  // HTTP health check: simplesmente checa se a porta está aberta
  return checarPorta(servico.porta);
}

// ─── Checar estado do Docker (instalado / daemon rodando) ───
let _dockerCache = { ts: 0, valor: null };
function checarDocker() {
  return new Promise((resolve) => {
    // Cache curto (4s) para não disparar 'docker version' a cada poll de 5s
    const agora = Date.now();
    if (_dockerCache.valor && agora - _dockerCache.ts < 4000) {
      return resolve(_dockerCache.valor);
    }
    exec('docker version --format "{{.Server.Version}}"', { timeout: 6000 }, (err, stdout, stderr) => {
      let valor;
      if (!err && stdout.trim()) {
        valor = { instalado: true, rodando: true, versao: stdout.trim() };
      } else {
        const saida = `${stderr || ""} ${err?.message || ""}`.toLowerCase();
        const naoInstalado =
          err?.code === "ENOENT" ||
          saida.includes("not recognized") ||
          saida.includes("reconhecido") ||
          saida.includes("não é reconhecido");
        valor = naoInstalado
          ? { instalado: false, rodando: false }
          : { instalado: true, rodando: false };
      }
      _dockerCache = { ts: Date.now(), valor };
      resolve(valor);
    });
  });
}

// ─── Obter status completo de todos os apps ───
async function obterStatusCompleto() {
  const registro = carregarRegistro();
  const resultado = {};

  // Apps
  for (const [appId, app] of Object.entries(registro.apps)) {
    resultado[appId] = {
      nome: app.nome,
      diretorio: app.diretorio,
      servicos: {},
    };
    for (const [svcId, svc] of Object.entries(app.servicos)) {
      const chave = `${appId}:${svcId}`;
      const procInfo = processos.get(chave);
      const online = await checarHealth(svc);
      resultado[appId].servicos[svcId] = {
        ...svc,
        online,
        gerenciado: !!procInfo,
        ehDocker: ehServicoDocker(svc),
        pid: procInfo?.proc?.pid || null,
      };
    }
  }

  // Infra compartilhada
  resultado["_infra"] = { nome: "Infraestrutura Compartilhada", servicos: {} };
  for (const [id, svc] of Object.entries(registro.infraCompartilhada)) {
    const online = await checarPorta(svc.porta);
    resultado["_infra"].servicos[id] = {
      ...svc,
      online,
      gerenciado: false,
    };
  }

  return resultado;
}

// ─── Detectar conflitos de porta ───
function detectarConflitos() {
  const registro = carregarRegistro();
  const portaMap = new Map(); // porta → [{app, servico}]

  for (const [appId, app] of Object.entries(registro.apps)) {
    for (const [svcId, svc] of Object.entries(app.servicos)) {
      const p = svc.porta;
      if (!portaMap.has(p)) portaMap.set(p, []);
      portaMap.get(p).push({ app: app.nome, servico: svcId, appId });
    }
  }
  for (const [id, svc] of Object.entries(registro.infraCompartilhada)) {
    const p = svc.porta;
    if (!portaMap.has(p)) portaMap.set(p, []);
    portaMap.get(p).push({ app: svc.nome, servico: id, appId: `_infra:${id}` });
  }

  const conflitos = [];
  for (const [porta, usuarios] of portaMap) {
    if (usuarios.length > 1) {
      conflitos.push({ porta, usuarios });
    }
  }
  return conflitos;
}

// ─── Obter processo que ocupa uma porta (Windows) ───
function obterProcessoNaPorta(porta) {
  return new Promise((resolve) => {
    exec(`netstat -ano | findstr :${porta} | findstr LISTENING`, (err, stdout) => {
      if (err || !stdout.trim()) return resolve(null);
      const linhas = stdout.trim().split("\n");
      const pids = new Set();
      for (const linha of linhas) {
        const partes = linha.trim().split(/\s+/);
        const pid = partes[partes.length - 1];
        if (pid && pid !== "0") pids.add(pid);
      }
      if (pids.size === 0) return resolve(null);

      const pidList = [...pids];
      const promises = pidList.map(
        (pid) =>
          new Promise((res) => {
            exec(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, (e, out) => {
              if (e || !out.trim()) return res({ pid, nome: "desconhecido" });
              const match = out.match(/"([^"]+)"/);
              res({ pid, nome: match ? match[1] : "desconhecido" });
            });
          })
      );
      Promise.all(promises).then(resolve);
    });
  });
}

// ─── Detectar se um serviço é gerenciado via Docker ───
// Serviços Docker têm ciclo de vida próprio (up -d / stop). O Manager NÃO deve
// dar taskkill na porta deles — quem ocupa a porta publicada é o proxy do Docker
// Desktop, e matá-lo derruba o Docker inteiro.
function ehServicoDocker(svc) {
  return /docker/i.test(svc?.comando || "") || /docker/i.test(svc?.tecnologia || "");
}

// ─── Derivar comando de parada (fallback) a partir do comando de start ───
function derivarComandoParar(comando) {
  // Pega o último "docker compose ..." e troca o "up -d ..." por "stop"
  const idx = comando.toLowerCase().lastIndexOf("docker compose");
  const base = idx >= 0 ? comando.slice(idx) : comando;
  return base.replace(/\bup\b\s+-d.*$/i, "stop").trim();
}

// ─── Iniciar um serviço (mata a porta antes para evitar EADDRINUSE) ───
async function iniciarServico(appId, svcId) {
  const registro = carregarRegistro();
  const app = registro.apps[appId];
  if (!app) return { ok: false, erro: `App "${appId}" não encontrado` };
  const svc = app.servicos[svcId];
  if (!svc) return { ok: false, erro: `Serviço "${svcId}" não encontrado em "${appId}"` };

  const chave = `${appId}:${svcId}`;
  if (processos.has(chave)) {
    return { ok: false, erro: "Serviço já está gerenciado. Pare-o primeiro." };
  }

  const cwd = path.resolve(__dirname, svc.cwd);
  if (!fs.existsSync(cwd)) {
    return { ok: false, erro: `Diretório não encontrado: ${cwd}` };
  }

  const ehDocker = ehServicoDocker(svc);

  // Serviço baseado em Docker: não adianta tentar se o daemon estiver desligado
  if (ehDocker) {
    const docker = await checarDocker();
    if (!docker.instalado) {
      return { ok: false, erro: "Docker não está instalado ou não está no PATH desta máquina." };
    }
    if (!docker.rodando) {
      return { ok: false, erro: "Docker Desktop está desligado. Inicie o Docker Desktop e tente novamente." };
    }
  }

  // Matar quem ocupa a porta antes de iniciar — APENAS para serviços não-Docker.
  // Para Docker, `up -d` é idempotente e a porta é dona do proxy do Docker;
  // matá-la quebraria o Docker. (ver ehServicoDocker)
  let portaLiberada = null;
  if (!ehDocker) {
    const portaEmUso = await checarPorta(svc.porta);
    if (portaEmUso) {
      console.log(`[KILL] Porta ${svc.porta} em uso — matando processo antes de iniciar ${appId}/${svcId}`);
      const killResult = await matarProcessoNaPorta(svc.porta);
      if (killResult.ok) {
        portaLiberada = { porta: svc.porta, pids: killResult.pids };
        // Aguarda a porta ser realmente liberada (max 3s)
        for (let i = 0; i < 6; i++) {
          await new Promise((r) => setTimeout(r, 500));
          if (!(await checarPorta(svc.porta))) break;
        }
      } else {
        return { ok: false, erro: `Porta ${svc.porta} em uso e não foi possível liberar: ${killResult.erro}` };
      }
    }
  }

  const logs = [];
  // Executa a linha de comando inteira no shell (cmd.exe no Windows).
  // Passar a string completa — em vez de split(" ") — preserva caminhos com
  // espaço/aspas e permite comandos compostos (ex.: "docker network create X & docker compose up -d").
  const extraEnv = svc.env || {};
  const proc = spawn(svc.comando, {
    cwd,
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, FORCE_COLOR: "0", ...extraEnv },
  });

  proc.stdout.on("data", (d) => {
    const linhas = d.toString().split("\n").filter((l) => l.trim());
    const ts = Date.now();
    for (const linha of linhas) {
      logs.push({ ts, tipo: "stdout", texto: linha });
    }
    while (logs.length > 500) logs.shift();
  });
  proc.stderr.on("data", (d) => {
    const linhas = d.toString().split("\n").filter((l) => l.trim());
    const ts = Date.now();
    for (const linha of linhas) {
      logs.push({ ts, tipo: "stderr", texto: linha });
    }
    while (logs.length > 500) logs.shift();
  });
  proc.on("exit", (code) => {
    logs.push({ ts: Date.now(), tipo: "exit", texto: `Processo encerrado (code ${code})` });
    processos.delete(chave);
  });

  processos.set(chave, { proc, logs, iniciadoEm: Date.now() });
  return { ok: true, pid: proc.pid, portaLiberada };
}

// ─── Parar um serviço ───
async function pararServico(appId, svcId) {
  const chave = `${appId}:${svcId}`;
  const registro = carregarRegistro();
  const svc = registro.apps[appId]?.servicos[svcId];

  // Serviço Docker: parar via `docker compose ... stop`. Os containers são
  // detached (não estão no mapa de processos), então taskkill não os pararia —
  // e taskkill na porta derrubaria o proxy do Docker.
  if (svc && ehServicoDocker(svc)) {
    const cwd = path.resolve(__dirname, svc.cwd);
    const cmdParar = svc.pararComando || derivarComandoParar(svc.comando);
    return new Promise((resolve) => {
      exec(cmdParar, { cwd, timeout: 90000 }, (err, stdout, stderr) => {
        processos.delete(chave);
        if (err) return resolve({ ok: false, erro: (stderr || err.message || "").trim() });
        resolve({ ok: true });
      });
    });
  }

  // Serviço comum (Node/Python): mata a árvore do processo gerenciado
  const info = processos.get(chave);
  if (!info) return { ok: false, erro: "Serviço não está sendo gerenciado" };

  try {
    // No Windows, precisa matar a árvore de processos
    exec(`taskkill /PID ${info.proc.pid} /T /F`, () => {});
    processos.delete(chave);
    return { ok: true };
  } catch (e) {
    return { ok: false, erro: e.message };
  }
}

// ─── Obter logs de um serviço ───
function obterLogs(appId, svcId) {
  const chave = `${appId}:${svcId}`;
  const info = processos.get(chave);
  if (!info) return [];
  return info.logs.slice(-200);
}

// ─── Listar PIDs em estado LISTENING numa porta (Windows) ───
function pidsListening(porta) {
  return new Promise((resolve) => {
    exec(`netstat -ano | findstr :${porta} | findstr LISTENING`, (err, stdout) => {
      if (err || !stdout.trim()) return resolve([]);
      const pids = new Set();
      for (const linha of stdout.trim().split("\n")) {
        const partes = linha.trim().split(/\s+/);
        const pid = partes[partes.length - 1];
        if (pid && pid !== "0") pids.add(pid);
      }
      resolve([...pids]);
    });
  });
}

// ─── Matar processo em uma porta (Windows) ───
async function matarProcessoNaPorta(porta) {
  const pids = await pidsListening(porta);
  if (pids.length === 0) return { ok: false, erro: "Nenhum processo encontrado" };
  let killed = 0;
  await Promise.all(
    pids.map((pid) => new Promise((res) => exec(`taskkill /PID ${pid} /T /F`, () => { killed++; res(); })))
  );
  return { ok: true, pids, killed };
}

// ─── Liberar as portas do Manager ANTES de subir (evita duplicação) ───
// Se já houver um Manager (ou qualquer processo) escutando em 9000/9001, mata-o
// antes do bind. Nunca mata o próprio processo (que ainda nem fez listen).
async function liberarPortasNoBoot() {
  for (const porta of MANAGER_PORTS) {
    const pids = (await pidsListening(porta)).filter((p) => String(p) !== String(process.pid));
    for (const pid of pids) {
      console.log(`[BOOT] Porta ${porta} ocupada pelo PID ${pid} — encerrando para evitar duplicação do Manager.`);
      await new Promise((res) => exec(`taskkill /PID ${pid} /T /F`, () => res()));
    }
  }
  // Aguarda as portas realmente liberarem (máx ~3s)
  for (let i = 0; i < 6; i++) {
    let algumaAberta = false;
    for (const porta of MANAGER_PORTS) if (await checarPorta(porta)) { algumaAberta = true; break; }
    if (!algumaAberta) return;
    await new Promise((r) => setTimeout(r, 500));
  }
}

// ─── Gerar comandos .cmd que matam as portas do Manager ───
function killPortsCmd() {
  return MANAGER_PORTS
    .map((p) => `for /f "tokens=5" %%A in ('netstat -aon ^| findstr ":${p} " ^| findstr LISTENING') do taskkill /F /PID %%A >nul 2>&1`)
    .join("\r\n");
}

// ─── Disparar um helper .cmd desacoplado (sobrevive à saída do node) ───
function dispararHelper(nome, conteudo) {
  const script = path.join(__dirname, nome);
  fs.writeFileSync(script, conteudo, "utf8");
  const child = spawn(process.env.ComSpec || "cmd.exe", ["/c", script], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    cwd: __dirname,
  });
  child.unref();
}

// ─── Reiniciar o próprio Manager ───
// service:    basta sair — o loop keep-alive do run-service.bat mata as portas e
//             sobe um node novo em ~5s. Sem instância concorrente.
// standalone: um relauncher desacoplado espera este processo sair, mata as portas
//             e sobe um node novo; este processo então sai.
async function reiniciarManager() {
  if (SOB_RUNNER) {
    setTimeout(() => process.exit(0), 400);
    return { ok: true, modo: "service", msg: "Reiniciando via serviço — volta em alguns segundos…" };
  }
  const conteudo = [
    "@echo off",
    "timeout /t 2 /nobreak >nul",
    killPortsCmd(),
    `cd /d "${__dirname}"`,
    `"${process.execPath}" server.mjs`,
    "",
  ].join("\r\n");
  dispararHelper("_sm-reiniciar.cmd", conteudo);
  setTimeout(() => process.exit(0), 400);
  return { ok: true, modo: "standalone", msg: "Reiniciando o Manager…" };
}

// ─── Finalizar o próprio Manager (parada limpa, sem auto-restart) ───
// Um helper desacoplado encerra a Tarefa Agendada (schtasks /End para a árvore
// wscript→cmd→node SEM disparar restart-on-failure), mata qualquer runner
// (run-service.bat/vbs) que tenha ficado solto e libera as portas 9000/9001.
async function finalizarManager() {
  const conteudo = [
    "@echo off",
    "timeout /t 1 /nobreak >nul",
    `schtasks /End /TN "${TASK_NAME}" >nul 2>&1`,
    `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'run-service' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }" >nul 2>&1`,
    killPortsCmd(),
    "",
  ].join("\r\n");
  dispararHelper("_sm-finalizar.cmd", conteudo);
  return { ok: true, modo: SOB_RUNNER ? "service" : "standalone", msg: "Finalizando o Manager…" };
}

// ─── Métricas de containers Docker (CPU/RAM/uptime) ───
let _metricasCache = { ts: 0, valor: [] };
function obterMetricas() {
  return new Promise((resolve) => {
    const agora = Date.now();
    if (_metricasCache.valor.length && agora - _metricasCache.ts < 2000) {
      return resolve(_metricasCache.valor);
    }
    // CPU/RAM por container (sem stream) + uptime via docker ps
    exec(
      'docker stats --no-stream --format "{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}"',
      { timeout: 8000 },
      (err, stdout) => {
        if (err || !stdout.trim()) {
          _metricasCache = { ts: Date.now(), valor: [] };
          return resolve([]);
        }
        const linhas = stdout.trim().split("\n");
        const metricas = linhas.map((l) => {
          const [nome, cpu, mem, memPerc] = l.split("\t");
          const cpuNum = parseFloat((cpu || "0").replace("%", "")) || 0;
          const memNum = parseFloat((memPerc || "0").replace("%", "")) || 0;
          return { nome, cpu: cpuNum, mem: (mem || "").trim(), memPerc: memNum };
        });
        _metricasCache = { ts: Date.now(), valor: metricas };
        resolve(metricas);
      }
    );
  });
}

// ─── Git: avisa quando o remoto está à frente (fetch throttled + cache) ───
// Roda `git fetch` no máx. a cada GIT_TTL e compara HEAD com o upstream de cada app
// que é repo git. Não bloqueia o snapshot: retorna o cache e atualiza em background.
const GIT_TTL = 5 * 60 * 1000; // 5 min entre fetches
let _gitCache = { apps: {}, ts: 0, checando: false };

function execP(cmd, opts = {}) {
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout: 20000, ...opts }, (err, stdout) => (err ? reject(err) : resolve(stdout || "")));
  });
}

async function atualizarGitCache() {
  const registro = carregarRegistro();
  // Apps do registro + repos vigiados que não são apps (server-manager, etc).
  const alvos = [
    ...Object.entries(registro.apps).map(([id, a]) => ({ id, nome: a.nome, diretorio: a.diretorio })),
    ...(registro.reposVigiados || []),
  ];
  const resultado = {};
  await Promise.all(alvos.map(async (alvo) => {
    if (!alvo.diretorio) return;
    const dir = path.resolve(__dirname, alvo.diretorio);
    try { await execP(`git -C "${dir}" rev-parse --is-inside-work-tree`); }
    catch { return; } // não é repo git — ignora

    // Remotes de verdade do repo. Nada aqui pode assumir o nome `origin`: o webapp
    // usa `webapp`, o irpf2026 usa `bruno`, o centria tem `base` e `origin`. Quando
    // a cascata só olhava `origin/*`, esses repos ficavam mudos no painel.
    let remotes = [];
    try {
      remotes = (await execP(`git -C "${dir}" remote`)).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    } catch { /* sem remote: sem aviso a dar */ }
    if (!remotes.length) return;
    remotes.sort((a, b) => (a === "origin" ? -1 : b === "origin" ? 1 : 0));

    // fetch NÃO-interativo, remote a remote: usa credencial em cache se houver; se
    // faltar, falha quieto em vez de abrir a janela do Git Credential Manager (que
    // pipocava 3–5x por ciclo). Um remote que falha não pode passar por "em dia",
    // então guardamos quais atualizaram para marcar o aviso como confiável ou não.
    const fetchOk = {};
    for (const rem of remotes) {
      try {
        await execP(`git -c credential.interactive=false -C "${dir}" fetch --prune --quiet ${rem}`,
          { env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "Never", GIT_ASKPASS: "echo" } });
        fetchOk[rem] = true;
      } catch { fetchOk[rem] = false; } // offline/sem credencial: segue com o que já tem localmente
    }

    let branch = "", ahead = 0, behind = 0, hasUpstream = false, compareRef = "", rastreado = false;
    try { branch = (await execP(`git -C "${dir}" rev-parse --abbrev-ref HEAD`)).trim(); } catch {}
    // Ref de comparação, em cascata: 1) upstream real do branch; 2) branch de mesmo
    // nome em algum remote; 3) branch default do remote (HEAD/main/master).
    // `rastreado` separa os dois primeiros casos (o branch tem par no remoto) do
    // terceiro (comparação contra a baseline, o branch só existe aqui).
    try {
      compareRef = (await execP(`git -C "${dir}" rev-parse --abbrev-ref @{upstream}`)).trim();
      hasUpstream = !!compareRef;
      rastreado = hasUpstream;
    } catch { /* sem upstream configurado */ }
    if (!compareRef && branch) {
      for (const rem of remotes) {
        try {
          await execP(`git -C "${dir}" rev-parse --verify --quiet ${rem}/${branch}`);
          compareRef = `${rem}/${branch}`;
          rastreado = true;
          break;
        } catch {}
      }
    }
    if (!compareRef) {
      for (const rem of remotes) {
        for (const cand of [`${rem}/HEAD`, `${rem}/main`, `${rem}/master`]) {
          try {
            const r = (await execP(`git -C "${dir}" rev-parse --abbrev-ref ${cand}`)).trim();
            if (r) { compareRef = r; break; }
          } catch {}
        }
        if (compareRef) break;
      }
    }
    if (compareRef) {
      try {
        const c = (await execP(`git -C "${dir}" rev-list --left-right --count HEAD...${compareRef}`)).trim();
        const [a, b] = c.split(/\s+/).map((n) => parseInt(n, 10) || 0);
        ahead = a;
        behind = b;
      } catch { compareRef = ""; }
    }
    // O aviso só vale se o remote usado na comparação foi de fato buscado agora.
    const remoteUsado = compareRef.split("/")[0];
    const verificado = !!compareRef && fetchOk[remoteUsado] === true;
    resultado[alvo.id] = { nome: alvo.nome, branch, ahead, behind, hasUpstream, compareRef, rastreado, verificado };
  }));
  _gitCache.apps = resultado;
  _gitCache.ts = Date.now();
}

function obterGitStatus() {
  if (!_gitCache.checando && Date.now() - _gitCache.ts > GIT_TTL) {
    _gitCache.checando = true;
    atualizarGitCache().catch(() => {}).finally(() => { _gitCache.checando = false; });
  }
  return _gitCache.apps;
}

// ─── SSE: snapshot completo do estado (status + docker + conflitos + métricas + git) ───
async function montarSnapshot() {
  const [status, docker, metricas] = await Promise.all([
    obterStatusCompleto(),
    checarDocker(),
    obterMetricas(),
  ]);
  return { status, docker, conflitos: detectarConflitos(), metricas, git: obterGitStatus(), ts: Date.now() };
}

const clientesStatus = new Set();
let _snapshotTimer = null;
let _computando = false;

function iniciarLoopSnapshot() {
  if (_snapshotTimer) return;
  _snapshotTimer = setInterval(async () => {
    if (clientesStatus.size === 0 || _computando) return;
    _computando = true;
    try {
      const snap = await montarSnapshot();
      const payload = `event: snapshot\ndata: ${JSON.stringify(snap)}\n\n`;
      for (const res of clientesStatus) {
        res.write(payload);
      }
    } catch (e) {
      console.error("[SSE] erro no snapshot:", e.message);
    } finally {
      _computando = false;
    }
  }, 2000);
}

// ─── Derivar comando de `logs -f` a partir do comando de start (Docker) ───
function derivarComandoLogs(comando) {
  const idx = comando.toLowerCase().lastIndexOf("docker compose");
  const base = idx >= 0 ? comando.slice(idx) : comando;
  return base.replace(/\bup\b\s+-d.*$/i, "logs -f --tail=200 --no-color").trim();
}

// ─── SSE: stream de logs ao vivo de um serviço ───
function streamLogs(req, res, appId, svcId) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write("retry: 3000\n\n");
  const enviar = (tipo, texto) =>
    res.write(`event: log\ndata: ${JSON.stringify({ tipo, texto, ts: Date.now() })}\n\n`);

  const registro = carregarRegistro();
  const svc = registro.apps[appId]?.servicos[svcId];
  if (!svc) {
    enviar("exit", `Serviço ${appId}/${svcId} não encontrado`);
    return res.end();
  }

  const hb = setInterval(() => res.write(": hb\n\n"), 15000);

  if (ehServicoDocker(svc)) {
    // Logs do container via `docker compose ... logs -f`
    const cwd = path.resolve(__dirname, svc.cwd);
    const cmdLogs = derivarComandoLogs(svc.comando);
    enviar("stdout", `$ ${cmdLogs}`);
    const proc = spawn(cmdLogs, { cwd, shell: true, stdio: ["ignore", "pipe", "pipe"] });
    const onData = (tipo) => (d) => {
      for (const linha of d.toString().split("\n")) {
        if (linha.trim()) enviar(tipo, linha);
      }
    };
    proc.stdout.on("data", onData("stdout"));
    proc.stderr.on("data", onData("stdout")); // docker manda progresso no stderr
    proc.on("exit", (code) => enviar("exit", `logs encerrado (code ${code})`));
    req.on("close", () => {
      clearInterval(hb);
      try {
        exec(`taskkill /PID ${proc.pid} /T /F`, () => {});
      } catch {}
    });
    return;
  }

  // Serviço Node/Python gerenciado: manda o buffer atual e depois o diff
  const chave = `${appId}:${svcId}`;
  let enviados = 0;
  const flush = () => {
    const info = processos.get(chave);
    if (!info) return;
    const novos = info.logs.slice(enviados);
    enviados = info.logs.length;
    for (const l of novos) enviar(l.tipo, l.texto);
  };
  flush();
  const poll = setInterval(flush, 1000);
  req.on("close", () => {
    clearInterval(hb);
    clearInterval(poll);
  });
}

// ─── Servidor HTTP ───
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
};

// ─── Helper para parsear JSON com segurança ───
function parseJsonSeguro(str) {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

async function handler(req, res) {
  try {
    const url = new URL(req.url, `http://localhost:${MANAGER_PORT}`);

    // CORS
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      return res.end();
    }

    // ── API Routes ──
    if (url.pathname === "/api/status") {
      const status = await obterStatusCompleto();
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(status));
    }

    if (url.pathname === "/api/docker") {
      const docker = await checarDocker();
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(docker));
    }

    if (url.pathname === "/api/metricas") {
      const metricas = await obterMetricas();
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(metricas));
    }

    // ── SSE: stream do estado completo (status + docker + conflitos + métricas) ──
    if (url.pathname === "/api/stream") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.write("retry: 3000\n\n");
      clientesStatus.add(res);
      iniciarLoopSnapshot();
      // snapshot imediato
      montarSnapshot()
        .then((snap) => res.write(`event: snapshot\ndata: ${JSON.stringify(snap)}\n\n`))
        .catch(() => {});
      const hb = setInterval(() => res.write(": hb\n\n"), 15000);
      req.on("close", () => {
        clearInterval(hb);
        clientesStatus.delete(res);
      });
      return;
    }

    // ── SSE: logs ao vivo de um serviço ──
    if (url.pathname === "/api/logs/stream") {
      return streamLogs(req, res, url.searchParams.get("appId"), url.searchParams.get("svcId"));
    }

    if (url.pathname === "/api/conflitos") {
      const conflitos = detectarConflitos();
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(conflitos));
    }

    if (url.pathname === "/api/git-refresh" && req.method === "POST") {
      _gitCache.ts = 0; // ignora o TTL — verificação sob demanda ("Verificar agora")
      await atualizarGitCache().catch(() => {});
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(_gitCache.apps));
    }

    if (url.pathname === "/api/portas" && req.method === "GET") {
      const registro = carregarRegistro();
      const mapa = [];
      for (const [appId, app] of Object.entries(registro.apps)) {
        for (const [svcId, svc] of Object.entries(app.servicos)) {
          mapa.push({ app: app.nome, appId, servico: svcId, porta: svc.porta, tipo: svc.tipo, tecnologia: svc.tecnologia });
        }
      }
      for (const [id, svc] of Object.entries(registro.infraCompartilhada)) {
        mapa.push({ app: svc.nome, appId: "_infra", servico: id, porta: svc.porta, tipo: svc.tipo, tecnologia: svc.tecnologia });
      }
      mapa.sort((a, b) => a.porta - b.porta);
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(mapa));
    }

    if (url.pathname === "/api/processo-porta" && req.method === "GET") {
      const porta = parseInt(url.searchParams.get("porta"));
      if (!porta) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ erro: "Parâmetro 'porta' obrigatório" }));
      }
      const info = await obterProcessoNaPorta(porta);
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(info || []));
    }

    if (url.pathname === "/api/iniciar" && req.method === "POST") {
      const body = await lerBody(req);
      const dados = parseJsonSeguro(body);
      if (!dados) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ ok: false, erro: "JSON inválido no body" }));
      }
      const result = await iniciarServico(dados.appId, dados.svcId);
      res.writeHead(result.ok ? 200 : 400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(result));
    }

    if (url.pathname === "/api/parar" && req.method === "POST") {
      const body = await lerBody(req);
      const dados = parseJsonSeguro(body);
      if (!dados) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ ok: false, erro: "JSON inválido no body" }));
      }
      const result = await pararServico(dados.appId, dados.svcId);
      res.writeHead(result.ok ? 200 : 400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(result));
    }

    if (url.pathname === "/api/reiniciar" && req.method === "POST") {
      const body = await lerBody(req);
      const dados = parseJsonSeguro(body);
      if (!dados) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ ok: false, erro: "JSON inválido no body" }));
      }
      await pararServico(dados.appId, dados.svcId);
      await new Promise((r) => setTimeout(r, 2000));
      const result = await iniciarServico(dados.appId, dados.svcId);
      res.writeHead(result.ok ? 200 : 400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(result));
    }

    // ── Controle do PRÓPRIO Manager ──
    if (url.pathname === "/api/manager/reiniciar" && req.method === "POST") {
      const result = await reiniciarManager();
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(result));
    }

    if (url.pathname === "/api/manager/finalizar" && req.method === "POST") {
      const result = await finalizarManager();
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(result));
    }

    if (url.pathname === "/api/logs" && req.method === "GET") {
      const appId = url.searchParams.get("appId");
      const svcId = url.searchParams.get("svcId");
      const logs = obterLogs(appId, svcId);
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(logs));
    }

    // ── Rebuild de um serviço Docker: `up -d --build` com saída em streaming ──
    if (url.pathname === "/api/rebuild" && req.method === "POST") {
      const body = await lerBody(req);
      const dados = parseJsonSeguro(body);
      const registro = carregarRegistro();
      const svc = registro.apps[dados?.appId]?.servicos[dados?.svcId];
      if (!svc) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ ok: false, erro: "Serviço não encontrado" }));
      }
      if (!ehServicoDocker(svc) || !/\bup\b\s+-d/i.test(svc.comando)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ ok: false, erro: "Rebuild só se aplica a serviço Docker com 'up -d'" }));
      }
      const docker = await checarDocker();
      if (!docker.rodando) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ ok: false, erro: "Docker Desktop está desligado" }));
      }
      // Streaming de texto puro (a UI lê o body via fetch/ReadableStream)
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "X-Accel-Buffering": "no" });
      const cwd = path.resolve(__dirname, svc.cwd);
      const cmdBuild = svc.comando.replace(/(\bup\b\s+-d)/i, "$1 --build");
      res.write(`$ ${cmdBuild}\n(isso pode levar alguns minutos...)\n\n`);
      const proc = spawn(cmdBuild, { cwd, shell: true, stdio: ["ignore", "pipe", "pipe"] });
      proc.stdout.on("data", (d) => res.write(d.toString()));
      proc.stderr.on("data", (d) => res.write(d.toString()));
      proc.on("exit", (code) => {
        res.write(`\n\n=== Rebuild finalizado (code ${code}) ===\n`);
        res.end();
      });
      req.on("close", () => {
        try { exec(`taskkill /PID ${proc.pid} /T /F`, () => {}); } catch {}
      });
      return;
    }

    if (url.pathname === "/api/matar-porta" && req.method === "POST") {
      const body = await lerBody(req);
      const dados = parseJsonSeguro(body);
      if (!dados) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ ok: false, erro: "JSON inválido no body" }));
      }
      const result = await matarProcessoNaPorta(dados.porta);
      res.writeHead(result.ok ? 200 : 400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(result));
    }

    if (url.pathname === "/api/scan-portas" && req.method === "GET") {
      const registro = carregarRegistro();
      const todasPortas = new Set();
      for (const app of Object.values(registro.apps)) {
        for (const svc of Object.values(app.servicos)) {
          todasPortas.add(svc.porta);
        }
      }
      for (const svc of Object.values(registro.infraCompartilhada)) {
        todasPortas.add(svc.porta);
      }

      const resultados = [];
      for (const porta of [...todasPortas].sort((a, b) => a - b)) {
        const emUso = await checarPorta(porta);
        resultados.push({ porta, emUso });
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(resultados));
    }

    // ── Servir arquivos estáticos ──
    let filePath = url.pathname === "/" ? "/index.html" : url.pathname;
    filePath = path.join(__dirname, "public", filePath);

    if (!fs.existsSync(filePath)) {
      res.writeHead(404);
      return res.end("Não encontrado");
    }

    const ext = path.extname(filePath);
    const contentType = MIME[ext] || "application/octet-stream";
    const content = fs.readFileSync(filePath);
    res.writeHead(200, { "Content-Type": contentType });
    res.end(content);
  } catch (err) {
    console.error(`[ERRO] ${req.method} ${req.url}:`, err.message);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, erro: "Erro interno do servidor" }));
    }
  }
}

function lerBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
  });
}

// Bootstrap: mata portas ocupadas ANTES do bind (evita duplicação) e sobe os
// servidores. Um http.Server por porta (um único Server NÃO escuta em 2 portas).
// Todos compartilham o mesmo handler. Porta ocupada não derruba o Manager.
(async () => {
  await liberarPortasNoBoot();

  for (const porta of MANAGER_PORTS) {
    const srv = http.createServer(handler);
    srv.on("error", (e) => {
      if (e.code === "EADDRINUSE") console.error(`[AVISO] Porta ${porta} em uso — não escutando nela.`);
      else console.error(`[AVISO] Falha ao escutar em ${porta}: ${e.message}`);
    });
    srv.listen(porta, "0.0.0.0", () => {
      console.log(`[OK] Escutando em http://192.168.0.47:${porta}  (local: http://localhost:${porta})`);
    });
  }

  console.log(`\n╔══════════════════════════════════════════════════╗`);
  console.log(`║   SERVER MANAGER - Central Contábil              ║`);
  console.log(`║   Portas: ${MANAGER_PORTS.join(", ")}   modo: ${SOB_RUNNER ? "serviço " : "standalone"}       ║`);
  console.log(`╚══════════════════════════════════════════════════╝`);
  console.log(`Dashboard (rede):  http://192.168.0.47:${MANAGER_PORT}`);
  console.log(`API:               http://192.168.0.47:${MANAGER_PORT}/api/status\n`);
})();
