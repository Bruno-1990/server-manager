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
import os from "node:os";
import { fileURLToPath } from "node:url";
import { exec, spawn } from "node:child_process";
import * as tarefas from "./tarefas.mjs";

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


// ─── .env ao lado do server.mjs ───────────────────────────────────────────────
// Sem dependencia: o Manager nao tem node_modules. Guarda a ANTHROPIC_API_KEY
// (mensagem de commit) e o SM_GIT_LAN. O que ja veio do shell tem prioridade.
function carregarEnvLocal() {
  const arquivo = path.join(__dirname, ".env");
  if (!fs.existsSync(arquivo)) return;
  for (const linha of fs.readFileSync(arquivo, "utf8").split(/\r?\n/)) {
    const t = linha.trim();
    if (!t || t.startsWith("#")) continue;
    const igual = t.indexOf("=");
    if (igual < 1) continue;
    const chave = t.slice(0, igual).trim();
    let valor = t.slice(igual + 1).trim();
    if (/^".*"$/.test(valor) || /^'.*'$/.test(valor)) valor = valor.slice(1, -1);
    if (process.env[chave] === undefined) process.env[chave] = valor;
  }
}
carregarEnvLocal();
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
    exec(cmd, { timeout: 20000, ...opts }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout || "");
      // O Error do exec so traz "Command failed: <cmd>" — a razao de verdade fica
      // nos argumentos, que se perdiam aqui. Sem isto, um push recusado chegava na
      // tela como o comando repetido e mais nada.
      err.stdout = stdout || "";
      err.stderr = stderr || "";
      reject(err);
    });
  });
}

async function atualizarGitCache() {
  const registro = carregarRegistro();
  // Apps do registro + repos vigiados que não são apps (server-manager, etc).
  const alvos = [
    ...Object.entries(registro.apps).map(([id, a]) => ({ id, nome: a.nome, diretorio: a.diretorio, remotoDownload: a.remotoDownload, remotoEnvio: a.remotoEnvio, envioNaPrincipal: a.envioNaPrincipal })),
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
    // Trabalho ainda nao commitado: e o que o botao Enviar do painel fecha.
    let sujo = 0;
    try {
      sujo = (await execP(`git -C "${dir}" status --porcelain`, { maxBuffer: 8 * 1024 * 1024 }))
        .split(/\r?\n/).filter((s) => s.trim()).length;
    } catch {}
    // A comparação segue o destino real do botão Enviar (alvoPush): a principal
    // do remote, ou o branch de mesmo nome quando o app pede. Se a ref ainda não
    // existe lá (branch nova), vale a cascata acima.
    try {
      const alvoEnvio = await alvoPush(dir, alvo.remotoEnvio, alvo.envioNaPrincipal !== false);
      if (!alvoEnvio.erro && alvoEnvio.remote && alvoEnvio.branchRemoto) {
        const ref = `${alvoEnvio.remote}/${alvoEnvio.branchRemoto}`;
        const c = (await execP(`git -C "${dir}" rev-list --left-right --count HEAD...${ref}`)).trim();
        const [a, b] = c.split(/\s+/).map((n) => parseInt(n, 10) || 0);
        compareRef = ref; ahead = a; behind = b; rastreado = true;
      } else if (!alvoEnvio.erro) {
        rastreado = false;
      }
    } catch { /* ref ainda não existe no remote: vale a cascata */ }
    // O aviso só vale se o remote usado na comparação foi de fato buscado agora.
    const remoteUsado = compareRef.split("/")[0];
    let verificado = !!compareRef && fetchOk[remoteUsado] === true;
    // Com `remotoDownload`, o "remoto à frente" passa a ser medido contra ele.
    let refDownload = "";
    if (alvo.remotoDownload) {
      const dl = await alvoDownload(dir, alvo.remotoDownload, branch);
      if (dl.ref) {
        refDownload = dl.ref;
        try {
          behind = parseInt((await execP(`git -C "${dir}" rev-list --count HEAD..${dl.ref}`)).trim(), 10) || 0;
        } catch { behind = 0; }
        verificado = fetchOk[dl.remote] === true;
      } else {
        behind = 0;
        verificado = false;
      }
    }
    resultado[alvo.id] = { nome: alvo.nome, branch, ahead, behind, hasUpstream, compareRef, rastreado, verificado, sujo, refDownload };
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

// ─── Git: commitar e enviar pelo painel ────────────────────────────────────────
// O painel fecha o trabalho solto e manda pro remoto certo, sem ninguem digitar
// mensagem. O que protege: a lista de arquivos e SEMPRE explicita (nunca
// `git add .`), segredo nao entra, arquivo marcado como protegido no registro
// nao entra, e o push vai pro remoto/branch que a deteccao ja resolveu.

// Nunca entram num commit feito pelo painel, em repo nenhum. `.env.dist` e
// `.env.example` passam de proposito: sao gabaritos versionados, sem segredo.
const NUNCA_COMMITAR = [
  { re: /(^|\/)\.env$/i,                       motivo: "arquivo de ambiente com segredo" },
  { re: /(^|\/)\.env\.(local|dev|prod|production|staging)$/i, motivo: "arquivo de ambiente com segredo" },
  { re: /\.(pem|p12|pfx|key|keystore|jks)$/i,  motivo: "chave privada / certificado" },
  { re: /(^|\/)id_(rsa|dsa|ecdsa|ed25519)/i,   motivo: "chave SSH" },
  { re: /(^|\/)credentials?\.json$/i,          motivo: "credencial" },
  { re: /(^|\/)(token|refresh_token)\.json$/i, motivo: "token de acesso" },
  { re: /service[-_]?account.*\.json$/i,       motivo: "service account" },
];

function motivoBloqueio(caminho, protegidos) {
  const p = caminho.replace(/\\/g, "/");
  for (const { re, motivo } of NUNCA_COMMITAR) if (re.test(p)) return motivo;
  for (const alvo of protegidos || []) {
    const a = String(alvo).replace(/\\/g, "/");
    if (p === a || p.endsWith("/" + a)) return "protegido no registro (adaptacao local)";
  }
  return null;
}

// Arquivos que o repo declara como "nunca vao pro remoto" — ex.: as adaptacoes
// Windows do centria, listadas na secao 2 do WINDOWS-LOCAL.md.
function protegidosDoApp(appId) {
  const registro = carregarRegistro();
  const alvo = registro.apps?.[appId] || (registro.reposVigiados || []).find((r) => r.id === appId);
  return alvo?.arquivosProtegidos || [];
}

function alvoDoRegistro(appId) {
  const registro = carregarRegistro();
  if (registro.apps?.[appId]) {
    const a = registro.apps[appId];
    return { id: appId, nome: a.nome, diretorio: a.diretorio, remotoDownload: a.remotoDownload, remotoEnvio: a.remotoEnvio, envioNaPrincipal: a.envioNaPrincipal };
  }
  return (registro.reposVigiados || []).find((r) => r.id === appId) || null;
}

// `git status --porcelain -z`: separador NUL evita quebrar em nome com espaco ou
// acento. Em rename/copy o git manda o destino e, no token seguinte, a origem.
async function arquivosDoRepo(dir) {
  const bruto = await execP(`git -C "${dir}" status --porcelain -z`, { maxBuffer: 8 * 1024 * 1024 });
  const tokens = bruto.split("\0").filter((t) => t.length);
  const itens = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const codigo = t.slice(0, 2);
    const caminho = t.slice(3);
    if (/^[RC]/.test(codigo)) i++; // o proximo token e a origem do rename
    if (!caminho) continue;
    itens.push({ caminho, codigo: codigo.trim() || "??" });
  }
  return itens;
}

// Para onde o push vai. Primeiro o remote: o de `remotoEnvio` (URL no registro),
// senão o do upstream do branch, senão o principal (origin primeiro).
// Depois o branch remoto: por padrão a PRINCIPAL desse remote (HEAD/main/master),
// só por fast-forward — se a principal tiver commit que não está aqui, o push é
// recusado e o painel avisa; nunca merge nem force. `envioNaPrincipal: false` no
// registro volta ao branch de mesmo nome (o centria, que diverge do base/main).
async function principalDoRemote(dir, remote) {
  try {
    const r = (await execP(`git -C "${dir}" rev-parse --abbrev-ref ${remote}/HEAD`)).trim();
    const barra = r.indexOf("/");
    if (barra > 0 && r.slice(barra + 1) !== "HEAD") return r.slice(barra + 1);
  } catch {}
  for (const cand of ["main", "master"]) {
    try { await execP(`git -C "${dir}" rev-parse --verify --quiet ${remote}/${cand}`); return cand; } catch {}
  }
  return "";
}

async function alvoPush(dir, remotoEnvio, naPrincipal = true) {
  const branch = (await execP(`git -C "${dir}" rev-parse --abbrev-ref HEAD`)).trim();
  if (!branch || branch === "HEAD") return { erro: "repo em detached HEAD — sem branch para enviar" };
  let remote = "", upBranch = "";
  if (remotoEnvio) {
    remote = await remoteDaUrl(dir, remotoEnvio);
    if (!remote) return { branch, erro: `nenhum remote do repo aponta para ${remotoEnvio} (adicione com git remote add)` };
  } else {
    try {
      const up = (await execP(`git -C "${dir}" rev-parse --abbrev-ref @{upstream}`)).trim();
      const barra = up.indexOf("/");
      if (barra > 0) { remote = up.slice(0, barra); upBranch = up.slice(barra + 1); }
    } catch { /* sem upstream: cai no remoto principal abaixo */ }
    if (!remote) {
      const remotes = (await execP(`git -C "${dir}" remote`)).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      if (!remotes.length) return { erro: "repo sem remoto configurado" };
      remotes.sort((a, b) => (a === "origin" ? -1 : b === "origin" ? 1 : 0));
      remote = remotes[0];
    }
  }
  if (naPrincipal) {
    const principal = await principalDoRemote(dir, remote);
    if (!principal) return { branch, remote, erro: `não achei a main/master em ${remote} — rode um fetch` };
    return { branch, remote, branchRemoto: principal, novo: false, naPrincipal: true };
  }
  if (upBranch) return { branch, remote, branchRemoto: upBranch, novo: false };
  let novo = false;
  try { await execP(`git -C "${dir}" rev-parse --verify --quiet ${remote}/${branch}`); } catch { novo = true; }
  return { branch, remote, branchRemoto: branch, novo };
}

// De onde o painel BAIXA. Sem `remotoDownload` no registro, é o mesmo alvo do
// envio. Com ele (uma URL), só o baixar passa a olhar o remote que aponta para
// essa URL — ex.: o centria envia para `base` e baixa do centralcontabil-tech.
// Branch: o de mesmo nome lá, se existir; senão o default daquele remote.
function normalizarUrlGit(u) {
  return String(u || "").trim().toLowerCase().replace(/\.git$/, "").replace(/\/+$/, "");
}

async function remoteDaUrl(dir, url) {
  try {
    for (const linha of (await execP(`git -C "${dir}" remote -v`)).split(/\r?\n/)) {
      const [nome, u, tipo] = linha.trim().split(/\s+/);
      if (tipo === "(fetch)" && normalizarUrlGit(u) === normalizarUrlGit(url)) return nome;
    }
  } catch {}
  return "";
}

async function alvoDownload(dir, url, branch) {
  const remote = await remoteDaUrl(dir, url);
  if (!remote) return { erro: `nenhum remote do repo aponta para ${url} (adicione com git remote add)` };
  const cands = [branch && branch !== "HEAD" ? `${remote}/${branch}` : "", `${remote}/HEAD`, `${remote}/main`, `${remote}/master`].filter(Boolean);
  for (const cand of cands) {
    try {
      const r = (await execP(`git -C "${dir}" rev-parse --abbrev-ref ${cand}`)).trim();
      const barra = r.indexOf("/");
      if (barra > 0) return { remote, branchRemoto: r.slice(barra + 1), ref: r };
    } catch {}
  }
  return { erro: `remote ${remote} (${url}) sem branch para comparar — rode um fetch` };
}

async function detalheGit(appId) {
  const alvo = alvoDoRegistro(appId);
  if (!alvo?.diretorio) return { ok: false, erro: `app ${appId} nao esta no registro` };
  const dir = path.resolve(__dirname, alvo.diretorio);
  try { await execP(`git -C "${dir}" rev-parse --is-inside-work-tree`); }
  catch { return { ok: false, erro: `${alvo.nome} nao e repositorio git` }; }

  const protegidos = protegidosDoApp(appId);
  const itens = await arquivosDoRepo(dir);

  // Submodulo (modo 160000 no indice) nao e arquivo: o que entraria no commit e
  // um ponteiro de sha. Commitar isso sozinho, com mensagem escrita de um diff
  // que nem mostra conteudo, e pedir confusao — ainda mais quando e um gitlink
  // orfao, sem .gitmodules (caso do SPED/SPED). Fica de fora por padrao.
  const gitlinks = new Set();
  if (itens.length) {
    const lista = itens.map((a) => `"${a.caminho.replace(/"/g, '\\"')}"`).join(" ");
    try {
      const saida = await execP(`git -C "${dir}" ls-files -s -- ${lista}`, { maxBuffer: 8 * 1024 * 1024 });
      for (const linha of saida.split(/\r?\n/)) {
        if (!linha.startsWith("160000")) continue;
        const tab = linha.indexOf("\t");
        if (tab > 0) gitlinks.add(linha.slice(tab + 1).trim());
      }
    } catch { /* sem índice legível: segue sem a marcação */ }
  }

  const entram = [], bloqueados = [];
  for (const it of itens) {
    const motivo = gitlinks.has(it.caminho)
      ? "submódulo — o commit seria só um ponteiro de sha"
      : motivoBloqueio(it.caminho, protegidos);
    if (motivo) bloqueados.push({ ...it, motivo }); else entram.push(it);
  }
  const push = await alvoPush(dir, alvo.remotoEnvio, alvo.envioNaPrincipal !== false);
  const git = _gitCache.apps[appId] || {};

  // Quantos commits faltam enviar, contados AGORA. O `ahead` do cache tem ate 5
  // minutos de idade e, logo depois de um commit feito pelo painel, ainda diz
  // zero — foi assim que um repo com commit pronto virou "nada a enviar".
  // -1 = o branch ainda nao existe no remoto, entao tudo dele esta por enviar.
  let porEnviar = 0, porTrazer = 0;
  if (push.remote && push.branchRemoto) {
    let refRemota = true;
    try { await execP(`git -C "${dir}" rev-parse --verify --quiet ${push.remote}/${push.branchRemoto}`); }
    catch { refRemota = false; }
    if (!refRemota) porEnviar = -1;
    else {
      try {
        const n = await execP(`git -C "${dir}" rev-list --count ${push.remote}/${push.branchRemoto}..HEAD`);
        porEnviar = parseInt(n.trim(), 10) || 0;
      } catch {}
      // Commit que existe la e nao aqui. Com isto > 0 o push SERA recusado por
      // non-fast-forward, entao a previa avisa antes de o commit ser feito a toa.
      try {
        const n = await execP(`git -C "${dir}" rev-list --count HEAD..${push.remote}/${push.branchRemoto}`);
        porTrazer = parseInt(n.trim(), 10) || 0;
      } catch {}
    }
  }

  // Baixar com remoto próprio: o "à frente" e o pull olham para ele, não para o
  // alvo do push. `atrasoPush` guarda o atraso do lado do envio (push recusado).
  const atrasoPush = porTrazer;
  let download = null;
  if (alvo.remotoDownload) {
    const dl = await alvoDownload(dir, alvo.remotoDownload, push.branch || git.branch);
    download = { url: alvo.remotoDownload, remote: dl.remote || null, branchRemoto: dl.branchRemoto || null, erro: dl.erro || null };
    porTrazer = 0;
    if (dl.ref) {
      try { porTrazer = parseInt((await execP(`git -C "${dir}" rev-list --count HEAD..${dl.ref}`)).trim(), 10) || 0; } catch {}
    }
  }

  return {
    ok: true, id: appId, nome: alvo.nome, dir,
    branch: push.branch || git.branch || "?",
    remote: push.remote, branchRemoto: push.branchRemoto, branchNovo: !!push.novo,
    erroAlvo: push.erro || null,
    download, atrasoPush,
    porEnviar, porTrazer, ahead: git.ahead || 0, behind: git.behind || 0,
    entram, bloqueados,
  };
}

// ─── Mensagem do commit, escrita a partir do diff ─────────────────────────────
const MODELO_MENSAGEM = process.env.SM_COMMIT_MODEL || "claude-sonnet-5";
const LIMITE_DIFF = 60000; // ~15k tokens de diff; acima disso o resumo ja basta

function mensagemSemIA(nome, entram, stat) {
  const escopo = entram.length === 1
    ? entram[0].caminho.split("/").pop().replace(/\.[^.]+$/, "")
    : `${entram.length} arquivos`;
  const lista = entram.slice(0, 20).map((a) => `- ${a.caminho}`).join("\n");
  const resto = entram.length > 20 ? `\n- ...e mais ${entram.length - 20}` : "";
  return [
    `chore(${nome}): atualiza ${escopo}`,
    "",
    "Commit feito pelo Server Manager sem ANTHROPIC_API_KEY configurada, entao",
    "esta mensagem e o resumo mecanico do diff — vale revisar e reescrever.",
    "",
    lista + resto,
    "",
    stat.trim(),
  ].join("\n");
}

async function gerarMensagem(dir, nome, entram) {
  const stat = await execP(`git -C "${dir}" diff --cached --stat`).catch(() => "");
  const chave = process.env.ANTHROPIC_API_KEY;
  if (!chave) return { texto: mensagemSemIA(nome, entram, stat), porIA: false };

  let diff = await execP(`git -C "${dir}" diff --cached`, { maxBuffer: 20 * 1024 * 1024 }).catch(() => "");
  let truncado = false;
  if (diff.length > LIMITE_DIFF) { diff = diff.slice(0, LIMITE_DIFF); truncado = true; }

  const prompt = [
    `Repositorio: ${nome}`,
    "",
    "Arquivos no commit:",
    entram.map((a) => `- ${a.caminho} (${a.codigo})`).join("\n"),
    "",
    "Resumo do diff:",
    stat.trim(),
    "",
    truncado ? "Diff (truncado no limite de tamanho):" : "Diff completo:",
    "```diff",
    diff,
    "```",
  ].join("\n");

  const sistema = [
    "Voce escreve mensagens de commit em portugues do Brasil, lendo o diff.",
    "Formato: Conventional Commit. Primeira linha `tipo(escopo): resumo` com no maximo",
    "72 caracteres, em minusculas, sem ponto final. Linha em branco. Depois um corpo",
    "detalhado, em paragrafos curtos ou bullets, explicando O QUE mudou e principalmente",
    "POR QUE — qual problema isso resolve, qual comportamento muda, o que alguem que ler",
    "daqui a seis meses precisa saber. Cite nomes reais de arquivos, funcoes e campos.",
    "Escreva apenas o que o diff sustenta: nao invente motivacao, ticket, numero nem teste.",
    "Se o diff foi truncado, descreva o que da para ver e nao especule sobre o resto.",
    "Responda SO com a mensagem do commit, sem cercas de codigo e sem preambulo.",
  ].join(" ");

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": chave,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODELO_MENSAGEM,
      max_tokens: 2000,
      system: sistema,
      messages: [{ role: "user", content: prompt }],
    }),
    signal: AbortSignal.timeout(90000),
  });
  if (!resp.ok) {
    const erro = await resp.text().catch(() => "");
    throw new Error(`API da Anthropic devolveu ${resp.status}: ${erro.slice(0, 300)}`);
  }
  const corpo = await resp.json();
  const texto = (corpo.content || [])
    .filter((b) => b.type === "text").map((b) => b.text).join("").trim();
  if (!texto) throw new Error("a API respondeu sem texto");
  return { texto: `${texto}\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n`, porIA: true };
}


// O Git Credential Manager as vezes recusa a primeira tentativa com o token
// vencido e so entao renova ("Invalid username or token"). Uma segunda tentativa
// passa. Como o commit ja foi criado a esta altura, deixar morrer na primeira
// deixaria o repo commitado e nao enviado, sem motivo.
const RECUSA_DE_CREDENCIAL =
  /Authentication failed|Invalid username or token|could not read Username|terminal prompts disabled/i;
// GCM sem credencial guardada tenta abrir a JANELA de login. `GIT_TERMINAL_PROMPT=0`
// nao impede isso — so corta o prompt de terminal — e num processo headless como o
// Manager a janela nunca aparece para ninguem: o push fica pendurado ate o timeout
// e volta "Command failed" sem uma linha de motivo. Com o bloqueio completo o git
// desiste na hora e diz o que faltou.
const SEM_INTERACAO = {
  GIT_TERMINAL_PROMPT: "0",
  GCM_INTERACTIVE: "Never",
  GIT_ASKPASS: "echo",
};
const FALTA_CREDENCIAL = /Cannot prompt because user interactivity has been disabled|unable to get password|could not read (Username|Password)/i;

// A saida util do git vem no stdout (o comando usa 2>&1); e.message so tem
// "Command failed: <cmd>". Juntar os dois e o que da uma mensagem legivel na tela.
function saidaDoErro(e) {
  return [e.stdout, e.stderr, e.message].filter(Boolean).join("\n").trim();
}

async function empurrar(dir, flagU, remote, branch, branchRemoto, registrar) {
  const cmd = `git -C "${dir}" -c credential.interactive=false push ${flagU}${remote} ${branch}:${branchRemoto} 2>&1`;
  const opts = { timeout: 120000, env: { ...process.env, ...SEM_INTERACAO } };
  try {
    return await execP(cmd, opts);
  } catch (e) {
    const saida = saidaDoErro(e);
    // Token vencido: o GCM recusa a primeira e renova; a segunda passa.
    if (RECUSA_DE_CREDENCIAL.test(saida) && !FALTA_CREDENCIAL.test(saida)) {
      registrar("o remoto recusou a credencial na primeira tentativa; repetindo", "aviso");
      try { return await execP(cmd, opts); } catch (e2) { throw new Error(erroDePush(e2, remote)); }
    }
    throw new Error(erroDePush(e, remote));
  }
}

function erroDePush(e, remote) {
  const saida = saidaDoErro(e);
  if (FALTA_CREDENCIAL.test(saida)) {
    return `sem credencial de push utilizavel para o remoto "${remote}", e o Manager roda headless: `
         + `nao ha janela de login para responder. Ou nunca houve credencial de escrita (repo publico `
         + `busca sem login nenhum, entao nada chega a ser guardado), ou a que existia foi recusada `
         + `pelo GitHub agora e o Credential Manager a apagou — que e o comportamento normal dele com `
         + `token vencido ou revogado. Rodar uma vez, na maquina do Manager: node cache-git-creds.mjs`;
  }
  if (/non-fast-forward|fetch first|rejected/i.test(saida)) {
    return `o remoto recusou: ha commit la que nao esta aqui. Trazer do remoto antes de enviar.\n\n${saida}`;
  }
  if (/ETIMEDOUT|timed out|Could not resolve host/i.test(saida)) {
    return `nao deu para falar com o remoto (rede ou host fora do ar).\n\n${saida}`;
  }
  return saida || "o push falhou sem dizer o motivo";
}

// ─── Commitar + enviar ────────────────────────────────────────────────────────
async function commitarEEnviar(appId) {
  const passos = [];
  const registrar = (texto, tipo = "info") => { passos.push({ texto, tipo }); };

  const d = await detalheGit(appId);
  if (!d.ok) return { ok: false, erro: d.erro, passos };
  if (d.erroAlvo) return { ok: false, erro: d.erroAlvo, passos };

  const { dir, nome, entram, bloqueados, remote, branch, branchRemoto, branchNovo } = d;
  registrar(`${nome} — branch ${branch} -> ${remote}/${branchRemoto}${branchNovo ? " (branch nova no remoto)" : ""}`);
  for (const b of bloqueados) registrar(`fora do commit: ${b.caminho} — ${b.motivo}`, "aviso");

  let mensagem = null, porIA = false;
  if (entram.length) {
    // add explicito, arquivo a arquivo. `--` separa caminhos de opcoes: nome que
    // comeca com hifen nao vira flag.
    const lista = entram.map((a) => `"${a.caminho.replace(/"/g, '\\"')}"`).join(" ");
    await execP(`git -C "${dir}" add -- ${lista}`, { maxBuffer: 4 * 1024 * 1024 });
    registrar(`${entram.length} arquivo(s) preparado(s)`);

    try {
      const m = await gerarMensagem(dir, nome, entram);
      mensagem = m.texto; porIA = m.porIA;
      registrar(porIA ? `mensagem escrita a partir do diff (${MODELO_MENSAGEM})` : "mensagem mecanica — sem ANTHROPIC_API_KEY", porIA ? "info" : "aviso");
    } catch (e) {
      const stat = await execP(`git -C "${dir}" diff --cached --stat`).catch(() => "");
      mensagem = mensagemSemIA(nome, entram, stat);
      registrar(`nao deu para escrever a mensagem pela API (${e.message}); usando o resumo mecanico`, "aviso");
    }

    const arquivoMsg = path.join(os.tmpdir(), `sm-commit-${Date.now()}.txt`);
    fs.writeFileSync(arquivoMsg, mensagem, "utf8");
    try {
      await execP(`git -C "${dir}" commit -F "${arquivoMsg}"`, { maxBuffer: 4 * 1024 * 1024 });
      registrar(`commit criado: ${mensagem.split("\n")[0]}`, "ok");
    } finally {
      try { fs.unlinkSync(arquivoMsg); } catch {}
    }
  } else if (d.porEnviar !== 0) {
    const quantos = d.porEnviar === -1 ? "branch inteira (nova no remoto)" : `${d.porEnviar} commit(s)`;
    registrar(`nada novo para commitar — enviando ${quantos} que ja estava(m) commitado(s)`);
  } else {
    registrar("nada a commitar e nada a enviar", "ok");
    return { ok: true, semNada: true, passos, detalhe: d };
  }

  // Push que falha depois do commit feito NAO pode voltar so o erro: quem clicou
  // precisa ver que o commit existe e que basta reenviar. Por isso o log de passos
  // e a mensagem gerada acompanham a falha.
  const flagU = branchNovo ? "-u " : "";
  let saidaPush;
  try {
    saidaPush = await empurrar(dir, flagU, remote, branch, branchRemoto, registrar);
  } catch (e) {
    registrar(`o commit esta feito, mas nao foi enviado — clicar em Enviar de novo so refaz o push`, "aviso");
    await atualizarGitCache().catch(() => {});
    return { ok: false, erro: e.message, passos, mensagem, porIA };
  }
  const linhaUtil = saidaPush.split(/\r?\n/).filter((l) => l.trim() && !/^remote:/.test(l)).pop();
  registrar(`enviado para ${remote}/${branchRemoto}${linhaUtil ? ` — ${linhaUtil.trim()}` : ""}`, "ok");

  await atualizarGitCache().catch(() => {});
  return { ok: true, passos, mensagem, porIA };
}


// ─── Trazer do remoto (só fast-forward) ──────────────────────────────────────
// `--ff-only` é a escolha deliberada: ou o histórico local é um prefixo do
// remoto e o merge é um avanço de ponteiro, ou o git recusa e nada acontece. O
// painel nunca vai criar merge nem deixar conflito para alguém resolver pela
// web; divergência de verdade continua sendo assunto de terminal.
async function trazerDoRemoto(appId) {
  const passos = [];
  const registrar = (texto, tipo = "info") => { passos.push({ texto, tipo }); };

  const d = await detalheGit(appId);
  if (!d.ok) return { ok: false, erro: d.erro, passos };
  if (d.download?.erro) return { ok: false, erro: d.download.erro, passos };
  if (!d.download && d.erroAlvo) return { ok: false, erro: d.erroAlvo, passos };
  if (!d.porTrazer) { registrar("nada a trazer — já está em dia com o remoto", "ok"); return { ok: true, passos }; }

  const { dir, nome } = d;
  const remote = d.download ? d.download.remote : d.remote;
  const branchRemoto = d.download ? d.download.branchRemoto : d.branchRemoto;
  registrar(`${nome} — trazendo ${d.porTrazer} commit(s) de ${remote}/${branchRemoto}`);

  // Trabalho solto não impede um fast-forward, mas impede se tocar nos mesmos
  // arquivos que vêm. Avisar antes é mais honesto do que deixar o git recusar.
  if (d.entram.length) {
    registrar(`${d.entram.length} arquivo(s) sem commit aqui — o git recusa se algum deles for tocado pelo que vem`, "aviso");
  }

  try {
    const saida = await execP(
      `git -C "${dir}" -c credential.interactive=false pull --ff-only ${remote} ${branchRemoto} 2>&1`,
      { timeout: 120000, env: { ...process.env, ...SEM_INTERACAO } }
    );
    const linha = saida.split(/\r?\n/).filter((l) => l.trim()).pop();
    registrar(`trazido${linha ? ` — ${linha.trim()}` : ""}`, "ok");
  } catch (e) {
    const saida = saidaDoErro(e);
    if (/not possible to fast-forward|diverged/i.test(saida)) {
      throw new Error(
        `os históricos divergiram: há commit aqui que não está no remoto e vice-versa. ` +
        `Fast-forward não resolve isso, e o painel não faz merge — resolver no terminal, em ${dir}`
      );
    }
    if (/local changes .* would be overwritten|Please commit your changes/i.test(saida)) {
      throw new Error(
        `há alteração sem commit nos mesmos arquivos que vêm do remoto. ` +
        `Commitar primeiro (botão Enviar comita, mas o push só passa depois desta atualização), ou guardar à mão.`
      );
    }
    throw new Error(saida || "não deu para trazer do remoto");
  }

  await atualizarGitCache().catch(() => {});
  return { ok: true, passos };
}

// Escrita no git so de quem esta NESTA maquina — o painel responde para toda a
// rede sem login, e commit/push escrevem no GitHub com a credencial daqui.
// SM_GIT_LAN=1 abre para a rede inteira, se algum dia for o que se quer.
function ipsDestaMaquina() {
  const ips = new Set(["127.0.0.1", "::1", ""]);
  for (const lista of Object.values(os.networkInterfaces() || {})) {
    for (const ni of lista || []) ips.add(ni.address);
  }
  return ips;
}
function podeEscreverGit(req) {
  if (process.env.SM_GIT_LAN === "1") return true;
  const ip = (req.socket.remoteAddress || "").replace(/^::ffff:/, "");
  return ipsDestaMaquina().has(ip);
}

// ─── SSE: snapshot completo do estado (status + docker + conflitos + métricas + git) ───
async function montarSnapshot() {
  const [status, docker, metricas] = await Promise.all([
    obterStatusCompleto(),
    checarDocker(),
    obterMetricas(),
  ]);
  return {
    status,
    docker,
    conflitos: detectarConflitos(),
    metricas,
    git: obterGitStatus(),
    // As tarefas entram no snapshot, e não numa rota própria consultada de
    // tempos em tempos: quem está com o painel aberto vê a rotina disparar,
    // rodar e terminar sem apertar nada.
    tarefas: tarefas.listar(carregarRegistro()),
    ts: Date.now(),
  };
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


    // ── Commit + push pelo painel ──
    if (url.pathname === "/api/git/detalhe" && req.method === "GET") {
      const appId = url.searchParams.get("app") || "";
      const d = await detalheGit(appId);
      d.podeEscrever = podeEscreverGit(req);
      res.writeHead(d.ok ? 200 : 404, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(d));
    }

    if (url.pathname === "/api/git/trazer" && req.method === "POST") {
      if (!podeEscreverGit(req)) {
        res.writeHead(403, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ ok: false, erro: "so a partir da maquina do Manager." }));
      }
      const dados = parseJsonSeguro(await lerBody(req));
      if (!dados?.appId) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ ok: false, erro: "informe o appId" }));
      }
      try {
        const r = await trazerDoRemoto(dados.appId);
        res.writeHead(r.ok ? 200 : 400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify(r));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ ok: false, erro: (e.message || String(e)).slice(0, 1000) }));
      }
    }

    if (url.pathname === "/api/git/enviar" && req.method === "POST") {
      if (!podeEscreverGit(req)) {
        res.writeHead(403, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({
          ok: false,
          erro: "commit e push so podem ser disparados desta maquina. O painel responde para "
              + "a rede inteira sem login, e isto escreve no GitHub com a credencial daqui. "
              + "Para liberar para a rede, subir o Manager com SM_GIT_LAN=1.",
        }));
      }
      const dados = parseJsonSeguro(await lerBody(req));
      if (!dados?.appId) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ ok: false, erro: "informe o appId" }));
      }
      try {
        const r = await commitarEEnviar(dados.appId);
        res.writeHead(r.ok ? 200 : 400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify(r));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ ok: false, erro: (e.message || String(e)).slice(0, 1000) }));
      }
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

    // ─── Tarefas agendadas (ver tarefas.mjs) ───
    if (url.pathname === "/api/tarefas" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(tarefas.listar(carregarRegistro())));
    }

    if (url.pathname === "/api/tarefas/logs" && req.method === "GET") {
      const id = url.searchParams.get("id") || "";
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(tarefas.logsDe(id)));
    }

    if (url.pathname === "/api/tarefas/executar" && req.method === "POST") {
      const dados = parseJsonSeguro(await lerBody(req));
      const tarefa = carregarRegistro().tarefas?.[dados?.id];
      if (!tarefa) {
        res.writeHead(404, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ ok: false, erro: "Tarefa não encontrada" }));
      }
      // 'manual' fica gravado na execução: no mês seguinte, saber se a rodada
      // saiu sozinha ou porque alguém clicou é metade do diagnóstico.
      const result = tarefas.executar(tarefa, dados.id, "manual");
      res.writeHead(result.ok ? 200 : 400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(result));
    }

    if (url.pathname === "/api/tarefas/parar" && req.method === "POST") {
      const dados = parseJsonSeguro(await lerBody(req));
      const result = tarefas.parar(dados?.id);
      res.writeHead(result.ok ? 200 : 400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(result));
    }

    if (url.pathname === "/api/tarefas/alternar" && req.method === "POST") {
      const dados = parseJsonSeguro(await lerBody(req));
      const result = tarefas.alternar(dados?.id, dados?.habilitada !== false);
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

  // O agendador de tarefas roda SEMPRE, independente de haver alguém com o
  // painel aberto — ao contrário do loop de snapshot, que só trabalha quando
  // há cliente SSE conectado. Uma rotina mensal que só dispara com o navegador
  // aberto não é uma rotina automática.
  tarefas.iniciarLoop(carregarRegistro);
})();
