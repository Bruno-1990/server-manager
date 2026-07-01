/* ============================================================================
   Server Manager — frontend v2
   - Tempo real via SSE (/api/stream) com render incremental (sem flicker).
   - Logs ao vivo (/api/logs/stream), métricas (Chart.js), busca, acento.
   - Preserva o comportamento Docker-aware (nunca matarPorta em container).
   ============================================================================ */

// ─── Ícones (Lucide, inline) ───
const ICONS = {
  server: '<rect x="2" y="3" width="20" height="8" rx="2"/><rect x="2" y="13" width="20" height="8" rx="2"/><line x1="6" y1="7" x2="6.01" y2="7"/><line x1="6" y1="17" x2="6.01" y2="17"/>',
  search: '<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.64-6.36"/><polyline points="21 3 21 9 15 9"/>',
  play: '<polygon points="6 4 20 12 6 20 6 4"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  restart: '<path d="M3 12a9 9 0 1 0 2.64-6.36"/><polyline points="3 3 3 9 9 9"/>',
  external: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>',
  logs: '<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>',
  alert: '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
  activity: '<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>',
  cpu: '<rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><line x1="9" y1="1" x2="9" y2="4"/><line x1="15" y1="1" x2="15" y2="4"/><line x1="9" y1="20" x2="9" y2="23"/><line x1="15" y1="20" x2="15" y2="23"/><line x1="20" y1="9" x2="23" y2="9"/><line x1="20" y1="14" x2="23" y2="14"/><line x1="1" y1="9" x2="4" y2="9"/><line x1="1" y1="14" x2="4" y2="14"/>',
  box: '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/>',
  hammer: '<path d="M14 6l-3.5 3.5"/><path d="M2 22l3-3"/><path d="M14.5 5.5 18 2l4 4-3.5 3.5z"/><path d="M11 9 4 16a2.83 2.83 0 1 0 4 4l7-7"/>',
  layers: '<polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>',
  info: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>',
  network: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>',
};
function icon(nome) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[nome] || ""}</svg>`;
}

// ─── Estado ───
let snapshot = null;
let prevOnline = null; // Map "app:svc" -> bool, p/ detectar transições
const cardHtmlCache = new Map();
let filtro = "";

// ─── Acento ───
const ACENTOS = [
  ["Teal", "#4a9cbd"], ["Azul", "#4aa3ff"], ["Violeta", "#a78bfa"],
  ["Verde", "#2ee06b"], ["Âmbar", "#ffb020"], ["Rosa", "#f472b6"],
];
function aplicarAcento(cor) {
  document.documentElement.style.setProperty("--accent", cor);
  localStorage.setItem("sm-acento", cor);
  document.querySelectorAll(".swatch").forEach((s) => s.classList.toggle("active", s.dataset.cor === cor));
}
function montarAcentos() {
  const cor = localStorage.getItem("sm-acento") || ACENTOS[0][1];
  const wrap = document.getElementById("accent-picker");
  wrap.innerHTML = ACENTOS.map(([nome, c]) =>
    `<span class="swatch" style="background:${c}" data-cor="${c}" title="${nome}"></span>`
  ).join("");
  wrap.querySelectorAll(".swatch").forEach((s) => s.addEventListener("click", () => aplicarAcento(s.dataset.cor)));
  aplicarAcento(cor);
}

// ─── Inicialização ───
document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("brand-logo").innerHTML = icon("server");
  document.getElementById("search-icon").innerHTML = icon("search");
  document.getElementById("log-search-icon").innerHTML = icon("search");
  document.getElementById("btn-refresh").innerHTML = icon("refresh");
  document.getElementById("ico-metricas").innerHTML = icon("cpu");
  document.getElementById("ico-portas").innerHTML = icon("network");
  document.getElementById("toggle-metricas").innerHTML = icon("layers");
  document.getElementById("toggle-mapa-portas").innerHTML = icon("layers");
  montarAcentos();
  montarSkeleton();
  conectarStream();
  atualizarRelogio();
  setInterval(atualizarRelogio, 1000);

  document.getElementById("busca").addEventListener("input", (e) => { filtro = e.target.value; filtrarUI(); });
  document.getElementById("btn-refresh").addEventListener("click", forcarAtualizacao);
  document.getElementById("log-busca").addEventListener("input", renderLog);
  document.getElementById("log-wrap").addEventListener("change", (e) =>
    document.getElementById("modal-body").classList.toggle("nowrap", !e.target.checked));
  document.addEventListener("keydown", atalhos);
});

function montarSkeleton() {
  const grid = document.getElementById("grid-apps");
  grid.innerHTML = Array.from({ length: 6 }, () => '<div class="skeleton skel-card"></div>').join("");
}

function atualizarRelogio() {
  document.getElementById("relogio").textContent = new Date().toLocaleTimeString("pt-BR");
}

// ─── SSE: stream de estado ───
let stream = null;
function conectarStream() {
  if (stream) stream.close();
  stream = new EventSource("/api/stream");
  stream.addEventListener("snapshot", (e) => {
    try { aplicarSnapshot(JSON.parse(e.data)); } catch {}
    setLive(true);
  });
  stream.onerror = () => setLive(false);
  stream.onopen = () => setLive(true);
}
function forcarAtualizacao() { conectarStream(); }
function setLive(on) {
  const el = document.getElementById("live");
  el.classList.toggle("on", on);
  document.getElementById("live-label").textContent = on ? "ao vivo" : "reconectando…";
}

// ─── Aplicar snapshot (render incremental) ───
function aplicarSnapshot(snap) {
  snapshot = snap;
  renderHero(snap);
  renderDocker(snap.docker);
  renderConflitos(snap.conflitos);
  renderApps(snap.status);
  renderPortas(snap.status);
  renderMetricas(snap.metricas);
  detectarTransicoes(snap.status);
}

// ─── Detectar serviços que caíram/subiram ───
function detectarTransicoes(status) {
  const atual = new Map();
  for (const [appId, app] of Object.entries(status)) {
    for (const [svcId, svc] of Object.entries(app.servicos || {})) {
      atual.set(`${appId}:${svcId}`, { online: svc.online, nome: `${app.nome} / ${svcId}` });
    }
  }
  if (prevOnline) {
    for (const [chave, info] of atual) {
      const antes = prevOnline.get(chave);
      if (antes === undefined) continue;
      if (antes.online && !info.online) mostrarNotificacao(`${info.nome} caiu (offline)`, "warning");
      if (!antes.online && info.online) mostrarNotificacao(`${info.nome} está online`, "success");
    }
  }
  prevOnline = atual;
}

// ─── Hero / resumo ───
function renderHero(snap) {
  const status = snap.status;
  let total = 0, online = 0, apps = 0;
  for (const [appId, app] of Object.entries(status)) {
    if (appId !== "_infra") apps++;
    for (const svc of Object.values(app.servicos || {})) { total++; if (svc.online) online++; }
  }
  const conflitos = (snap.conflitos || []).length;
  const docker = snap.docker || {};
  const dockerTxt = docker.rodando ? `v${docker.versao}` : (docker.instalado ? "desligado" : "ausente");
  const dockerCor = docker.rodando ? "var(--success)" : "var(--warning)";

  const stats = [
    { label: "Serviços online", valor: `${online}/${total}`, sub: `${total - online} offline`, icon: "activity", cor: online === total ? "var(--success)" : "var(--accent)" },
    { label: "Aplicações", valor: apps, sub: "monitoradas", icon: "layers", cor: "var(--info)" },
    { label: "Docker", valor: docker.rodando ? "ON" : "OFF", sub: dockerTxt, icon: "box", cor: dockerCor },
    { label: "Conflitos", valor: conflitos, sub: conflitos ? "verificar portas" : "nenhum", icon: "alert", cor: conflitos ? "var(--danger)" : "var(--success)" },
  ];
  document.getElementById("hero").innerHTML = stats.map((s) => `
    <div class="stat" style="--stat-color:${s.cor}">
      <div class="stat-icon">${icon(s.icon)}</div>
      <div class="stat-label">${s.label}</div>
      <div class="stat-value">${s.valor}</div>
      <div class="stat-sub">${s.sub}</div>
    </div>`).join("");
}

// ─── Apps (incremental por card) ───
function cardClass(app) {
  const servicos = Object.values(app.servicos || {});
  const online = servicos.filter((s) => s.online).length;
  if (online === servicos.length && servicos.length) return "card-app card-online";
  if (online > 0) return "card-app card-parcial";
  return "card-app card-offline";
}

function renderApps(status) {
  const grid = document.getElementById("grid-apps");
  if (grid.querySelector(".skeleton")) grid.innerHTML = ""; // remove skeleton no 1º snapshot

  const appIds = Object.keys(status).filter((id) => id !== "_infra");
  for (const appId of appIds) {
    const app = status[appId];
    const html = cardAppHtml(appId, app);
    let el = document.getElementById("card-" + appId);
    if (!el) { el = document.createElement("div"); el.id = "card-" + appId; grid.appendChild(el); }
    el.className = cardClass(app);
    el.dataset.filtro = textoBusca(appId, app);
    if (cardHtmlCache.get(appId) !== html) { el.innerHTML = html; cardHtmlCache.set(appId, html); }
  }
  document.getElementById("conta-apps").textContent = `(${appIds.length})`;
  filtrarUI();
}

function textoBusca(appId, app) {
  let t = `${app.nome} ${appId}`;
  for (const [svcId, svc] of Object.entries(app.servicos || {})) {
    t += ` ${svcId} ${svc.tecnologia} ${svc.porta} ${svc.online ? "online" : "offline"}`;
  }
  return t;
}

function cardAppHtml(appId, app) {
  const servicos = Object.entries(app.servicos || {});
  const online = servicos.filter(([, s]) => s.online).length;
  const pct = servicos.length ? Math.round((online / servicos.length) * 100) : 0;
  const temOffline = servicos.some(([, s]) => !s.online && !s.gerenciado);
  const temParar = servicos.some(([, s]) => s.gerenciado || (s.ehDocker && s.online));
  const todosOnline = online === servicos.length && servicos.length > 0;

  const acoesApp = `
    ${temOffline ? `<button class="btn btn-sm btn-success" onclick="iniciarTudo('${appId}')" title="Iniciar serviços offline">${icon("play")} Tudo</button>` : ""}
    ${todosOnline && temParar ? `<button class="btn btn-sm btn-danger" onclick="pararTudo('${appId}')" title="Parar serviços">${icon("stop")} Tudo</button>` : ""}
    <div class="health-ring" style="--p:${pct}"><span>${pct}%</span></div>`;

  const linhas = servicos.map(([svcId, svc]) => servicoHtml(appId, svcId, svc)).join("");

  return `
    <div class="card-header">
      <div>
        <div class="card-titulo">${app.nome}</div>
        <div class="card-dir">${app.diretorio || ""}</div>
      </div>
      <div class="card-header-acoes">${acoesApp}</div>
    </div>
    <div class="card-servicos">${linhas}</div>`;
}

function servicoHtml(appId, svcId, svc) {
  const linkUrl = `http://${location.hostname}:${svc.porta}`;
  const temLink = svc.online && ["frontend", "backend", "fullstack"].includes(svc.tipo);
  const usaManager = svc.gerenciado || svc.ehDocker;
  const portaEl = temLink
    ? `<a href="${linkUrl}" target="_blank" class="servico-porta servico-link" title="Abrir ${linkUrl}">:${svc.porta}</a>`
    : `<span class="servico-porta">:${svc.porta}</span>`;

  let acoes;
  if (svc.online) {
    acoes = `
      <button class="btn btn-sm btn-icon btn-warning" onclick="${usaManager ? `reiniciarServico('${appId}','${svcId}')` : `adotarServico('${appId}','${svcId}',${svc.porta})`}" title="Reiniciar">${icon("restart")}</button>
      <button class="btn btn-sm btn-icon btn-danger" onclick="${usaManager ? `pararServico('${appId}','${svcId}')` : `matarPorta(${svc.porta})`}" title="Parar">${icon("stop")}</button>
      ${svc.ehDocker ? `<button class="btn btn-sm btn-icon btn-info" onclick="rebuild('${appId}','${svcId}')" title="Rebuild (--build)">${icon("hammer")}</button>` : ""}
      <button class="btn btn-sm btn-icon btn-ghost" onclick="verLogs('${appId}','${svcId}')" title="Logs">${icon("logs")}</button>`;
  } else {
    acoes = `
      <button class="btn btn-sm btn-success" onclick="iniciarServico('${appId}','${svcId}')" title="Iniciar ${svcId}">${icon("play")} :${svc.porta}</button>
      ${svc.ehDocker ? `<button class="btn btn-sm btn-icon btn-info" onclick="rebuild('${appId}','${svcId}')" title="Rebuild (--build)">${icon("hammer")}</button>` : ""}`;
  }

  return `
    <div class="servico-item">
      <div class="servico-info">
        <span class="dot ${svc.online ? "dot-online" : "dot-offline"}"></span>
        <span class="servico-nome">${svcId}</span>
        ${portaEl}
        <span class="servico-tech">${svc.tecnologia}</span>
      </div>
      <div class="servico-acoes">
        ${temLink ? `<a href="${linkUrl}" target="_blank" class="btn btn-sm btn-icon btn-link" title="Abrir">${icon("external")}</a>` : ""}
        ${acoes}
      </div>
    </div>`;
}

// ─── Conflitos ───
function renderConflitos(conflitos) {
  const secao = document.getElementById("secao-conflitos");
  const lista = document.getElementById("lista-conflitos");
  if (!conflitos || conflitos.length === 0) { secao.classList.add("hidden"); return; }
  secao.classList.remove("hidden");
  lista.innerHTML = conflitos.map((c) => `
    <div class="conflito-card">
      <div class="conflito-porta">Porta ${c.porta}</div>
      <div class="conflito-lista">Usada por: ${c.usuarios.map((u) => `<strong>${u.app}</strong> (${u.servico})`).join(", ")}</div>
    </div>`).join("");
}

// ─── Banner Docker ───
function renderDocker(docker) {
  const secao = document.getElementById("secao-docker");
  const aviso = document.getElementById("aviso-docker");
  if (!docker || docker.rodando) { secao.classList.add("hidden"); return; }
  const msg = !docker.instalado
    ? "Docker não está instalado ou não está no PATH desta máquina. Os serviços em container (Redis, PostgreSQL, LocalStack) não vão iniciar."
    : "Docker Desktop está DESLIGADO. Inicie o Docker Desktop para conseguir subir os serviços em container.";
  aviso.innerHTML = `${icon("alert")}<div><strong>Docker indisponível</strong><span>${msg}</span></div>`;
  secao.classList.remove("hidden");
}

// ─── Mapa de portas ───
function renderPortas(status) {
  const linhas = [];
  for (const [appId, app] of Object.entries(status)) {
    if (appId === "_infra") continue;
    for (const [svcId, svc] of Object.entries(app.servicos || {})) {
      linhas.push({ app: app.nome, appId, servico: svcId, ...svc });
    }
  }
  const infra = status["_infra"];
  if (infra) for (const [id, svc] of Object.entries(infra.servicos || {})) {
    linhas.push({ app: svc.nome || id, appId: "_infra", servico: id, ...svc });
  }
  linhas.sort((a, b) => a.porta - b.porta);

  const tbody = document.querySelector("#tabela-portas tbody");
  tbody.innerHTML = linhas.map((p) => {
    const ehDocker = p.ehDocker || /docker/i.test(p.tecnologia || "");
    const tipoClass = p.tipo === "frontend" ? "frontend" : p.tipo === "infra" ? "infra" : "";
    const linkUrl = `http://${location.hostname}:${p.porta}`;
    const temLink = p.online && ["frontend", "backend", "fullstack"].includes(p.tipo);
    return `
      <tr data-filtro="${p.app} ${p.servico} ${p.tecnologia} ${p.porta} ${p.online ? "online" : "offline"}">
        <td><span class="servico-porta">${p.porta}</span></td>
        <td>${p.app}</td>
        <td>${p.servico}</td>
        <td><span class="badge badge-tipo ${tipoClass}">${p.tipo}</span></td>
        <td>${p.tecnologia}</td>
        <td><span class="badge ${p.online ? "badge-online" : "badge-offline"}"><span class="dot ${p.online ? "dot-online" : "dot-offline"}"></span>${p.online ? "Online" : "Offline"}</span></td>
        <td class="td-acoes">
          ${temLink ? `<a href="${linkUrl}" target="_blank" class="btn btn-sm btn-icon btn-link" title="Abrir">${icon("external")}</a>` : ""}
          <button class="btn btn-sm btn-icon btn-ghost" onclick="infoPorta(${p.porta})" title="Ver processo">${icon("info")}</button>
          ${p.online && !ehDocker ? `<button class="btn btn-sm btn-danger" onclick="matarPorta(${p.porta})" title="Matar processo">Kill</button>` : ""}
        </td>
      </tr>`;
  }).join("");
  filtrarUI();
}

// ─── Métricas (Chart.js) ───
const MAXP = 30;
let chartLabels = [];
const cpuSeries = new Map();
let cpuChart = null;
const PALETA = ["#4aa3ff", "#2ee06b", "#ffb020", "#ff5468", "#a78bfa", "#22d3ee", "#f472b6", "#84cc16", "#fb923c", "#38bdf8", "#e879f9", "#4ade80", "#facc15"];

function renderMetricas(metricas) {
  const sec = document.getElementById("secao-metricas");
  if (!metricas || !metricas.length) { sec.classList.add("hidden"); return; }
  sec.classList.remove("hidden");
  document.getElementById("conta-metricas").textContent = `(${metricas.length})`;

  document.getElementById("metricas-lista").innerHTML = metricas
    .slice().sort((a, b) => b.cpu - a.cpu)
    .map((m) => `
      <div class="metrica-row">
        <span class="metrica-nome" title="${m.nome}">${m.nome}</span>
        <span class="metrica-bar"><i style="width:${Math.min(100, m.cpu)}%"></i></span>
        <span class="metrica-val">${m.cpu.toFixed(1)}%</span>
        <span class="metrica-mem">${m.mem}</span>
      </div>`).join("");

  atualizarChart(metricas);
}

function atualizarChart(metricas) {
  const label = new Date().toLocaleTimeString("pt-BR");
  chartLabels.push(label);
  if (chartLabels.length > MAXP) chartLabels.shift();
  const presentes = new Set(metricas.map((m) => m.nome));
  for (const m of metricas) {
    if (!cpuSeries.has(m.nome)) cpuSeries.set(m.nome, new Array(chartLabels.length - 1).fill(null));
    const arr = cpuSeries.get(m.nome); arr.push(m.cpu); if (arr.length > MAXP) arr.shift();
  }
  for (const [nome, arr] of cpuSeries) {
    if (!presentes.has(nome)) { arr.push(null); if (arr.length > MAXP) arr.shift(); }
  }
  const datasets = [...cpuSeries.entries()].map(([nome, arr], i) => ({
    label: nome.replace(/^webapp-|^aap-/, ""), data: arr,
    borderColor: PALETA[i % PALETA.length], backgroundColor: "transparent",
    borderWidth: 2, pointRadius: 0, tension: 0.35, spanGaps: true,
  }));

  if (!cpuChart) {
    const ctx = document.getElementById("chart-cpu").getContext("2d");
    cpuChart = new Chart(ctx, {
      type: "line",
      data: { labels: chartLabels, datasets },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        interaction: { mode: "nearest", intersect: false },
        plugins: { legend: { display: true, labels: { color: "#8aa6bd", boxWidth: 8, boxHeight: 8, font: { size: 9 } } } },
        scales: {
          x: { ticks: { color: "#5d7689", font: { size: 9 }, maxTicksLimit: 6 }, grid: { color: "rgba(255,255,255,0.04)" } },
          y: { beginAtZero: true, ticks: { color: "#5d7689", font: { size: 9 }, callback: (v) => v + "%" }, grid: { color: "rgba(255,255,255,0.04)" } },
        },
      },
    });
  } else {
    cpuChart.data.labels = chartLabels;
    cpuChart.data.datasets = datasets;
    cpuChart.update("none");
  }
}

// ─── Busca / filtro ───
function filtrarUI() {
  const q = filtro.trim().toLowerCase();
  document.querySelectorAll("#grid-apps > div").forEach((el) => {
    const t = (el.dataset.filtro || "").toLowerCase();
    el.classList.toggle("filtrado-oculto", !!q && !t.includes(q));
  });
  document.querySelectorAll("#tabela-portas tbody tr").forEach((tr) => {
    const t = (tr.dataset.filtro || "").toLowerCase();
    tr.classList.toggle("filtrado-oculto", !!q && !t.includes(q));
  });
}

// ─── Toggle seção ───
function toggleSecao(id) {
  const el = document.getElementById(id);
  el.classList.toggle("collapsed");
}

// ─── Atalhos de teclado ───
function atalhos(e) {
  if (e.key === "Escape") return fecharModal();
  const dentroInput = ["INPUT", "TEXTAREA"].includes(document.activeElement.tagName);
  if (dentroInput) return;
  if (e.key === "/") { e.preventDefault(); document.getElementById("busca").focus(); }
  if (e.key === "r") { e.preventDefault(); forcarAtualizacao(); }
}

// ─── API helper ───
async function fetchApi(path, opts = {}) {
  try { const res = await fetch(path, opts); return res.json(); }
  catch (e) { console.error("Erro na API:", e); return null; }
}
function post(path, body) {
  return fetchApi(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

// ─── Ações ───
async function iniciarServico(appId, svcId) {
  mostrarNotificacao(`Iniciando ${appId}/${svcId}...`, "info");
  const res = await post("/api/iniciar", { appId, svcId });
  if (res && res.ok) {
    if (res.portaLiberada) mostrarNotificacao(`Porta ${res.portaLiberada.porta} liberada`, "warning");
    mostrarNotificacao(`${appId}/${svcId} iniciado${res.pid ? ` (PID ${res.pid})` : ""}`, "success");
  } else mostrarNotificacao(`Erro: ${res?.erro || "falha"}`, "danger");
}

async function pararServico(appId, svcId) {
  const res = await post("/api/parar", { appId, svcId });
  mostrarNotificacao(res && res.ok ? `${appId}/${svcId} parado` : `Erro: ${res?.erro || "falha"}`, res && res.ok ? "warning" : "danger");
}

async function reiniciarServico(appId, svcId) {
  mostrarNotificacao(`Reiniciando ${appId}/${svcId}...`, "info");
  const res = await post("/api/reiniciar", { appId, svcId });
  mostrarNotificacao(res && res.ok ? `${appId}/${svcId} reiniciado` : `Erro: ${res?.erro || "falha"}`, res && res.ok ? "success" : "danger");
}

async function adotarServico(appId, svcId, porta) {
  mostrarNotificacao(`Parando processo externo na porta ${porta}...`, "warning");
  const kill = await post("/api/matar-porta", { porta });
  if (!kill || !kill.ok) return mostrarNotificacao(`Erro ao liberar porta ${porta}: ${kill?.erro || "falha"}`, "danger");
  await new Promise((r) => setTimeout(r, 1500));
  const res = await post("/api/iniciar", { appId, svcId });
  mostrarNotificacao(res && res.ok ? `${appId}/${svcId} agora é gerenciado (PID ${res.pid})` : `Erro: ${res?.erro || "falha"}`, res && res.ok ? "success" : "danger");
}

async function iniciarTudo(appId) {
  const app = snapshot?.status?.[appId];
  if (!app) return;
  const svcs = Object.entries(app.servicos).filter(([, s]) => !s.online && !s.gerenciado);
  if (!svcs.length) return mostrarNotificacao(`${appId}: tudo já online`, "info");
  mostrarNotificacao(`Iniciando ${svcs.length} serviço(s) de ${app.nome}...`, "info");
  for (const [svcId] of svcs) {
    const res = await post("/api/iniciar", { appId, svcId });
    mostrarNotificacao(res && res.ok ? `${svcId} iniciado` : `Erro em ${svcId}: ${res?.erro || "falha"}`, res && res.ok ? "success" : "danger");
  }
}

async function pararTudo(appId) {
  const app = snapshot?.status?.[appId];
  if (!app) return;
  const svcs = Object.entries(app.servicos).filter(([, s]) => s.gerenciado || (s.ehDocker && s.online));
  if (!svcs.length) return mostrarNotificacao(`${appId}: nada para parar`, "info");
  mostrarNotificacao(`Parando ${svcs.length} serviço(s)...`, "warning");
  for (const [svcId] of svcs) {
    const res = await post("/api/parar", { appId, svcId });
    mostrarNotificacao(res && res.ok ? `${svcId} parado` : `Erro em ${svcId}: ${res?.erro || "falha"}`, res && res.ok ? "warning" : "danger");
  }
}

async function infoPorta(porta) {
  const info = await fetchApi(`/api/processo-porta?porta=${porta}`);
  if (!info || info.length === 0) return mostrarNotificacao(`Porta ${porta}: nenhum processo`, "info");
  mostrarNotificacao(`Porta ${porta}: ${info.map((p) => `${p.nome} (PID ${p.pid})`).join(", ")}`, "info");
}

async function matarPorta(porta) {
  if (!confirm(`Matar processo(s) na porta ${porta}?`)) return;
  const res = await post("/api/matar-porta", { porta });
  mostrarNotificacao(res && res.ok ? `Porta ${porta} encerrada` : `Erro: ${res?.erro || "falha"}`, res && res.ok ? "warning" : "danger");
}

// ─── Logs ao vivo (SSE) ───
let logSource = null;
let logBuffer = [];
let logTitulo = "Logs";

function abrirModal(titulo) {
  logTitulo = titulo;
  document.getElementById("modal-titulo").textContent = titulo;
  document.getElementById("modal-logs").classList.remove("hidden");
}
function fecharModal() {
  document.getElementById("modal-logs").classList.add("hidden");
  if (logSource) { logSource.close(); logSource = null; }
}

function verLogs(appId, svcId) {
  abrirModal(`Logs: ${appId} / ${svcId}`);
  logBuffer = []; renderLog();
  if (logSource) logSource.close();
  logSource = new EventSource(`/api/logs/stream?appId=${appId}&svcId=${svcId}`);
  logSource.addEventListener("log", (e) => {
    try {
      const l = JSON.parse(e.data);
      logBuffer.push(l); if (logBuffer.length > 3000) logBuffer.shift();
      appendLogLine(l);
    } catch {}
  });
}

function appendLogLine(l) {
  const body = document.getElementById("modal-body");
  const q = document.getElementById("log-busca").value.trim().toLowerCase();
  if (q && !l.texto.toLowerCase().includes(q)) return;
  const span = document.createElement("span");
  span.className = "log-" + l.tipo;
  span.textContent = `[${new Date(l.ts).toLocaleTimeString("pt-BR")}] ${l.texto}`;
  body.appendChild(span);
  if (document.getElementById("log-autoscroll").checked) body.scrollTop = body.scrollHeight;
}

function renderLog() {
  const body = document.getElementById("modal-body");
  const q = document.getElementById("log-busca").value.trim().toLowerCase();
  body.innerHTML = logBuffer
    .filter((l) => !q || l.texto.toLowerCase().includes(q))
    .map((l) => {
      const linha = escapeHtml(`[${new Date(l.ts).toLocaleTimeString("pt-BR")}] ${l.texto}`);
      const hi = q ? realcar(linha, q) : linha;
      return `<span class="log-${l.tipo}">${hi}</span>`;
    }).join("");
  if (document.getElementById("log-autoscroll").checked) body.scrollTop = body.scrollHeight;
}

function realcar(texto, q) {
  const i = texto.toLowerCase().indexOf(q);
  if (i < 0) return texto;
  return texto.slice(0, i) + "<mark>" + texto.slice(i, i + q.length) + "</mark>" + texto.slice(i + q.length);
}

function copiarLogs() {
  const txt = logBuffer.map((l) => `[${new Date(l.ts).toLocaleTimeString("pt-BR")}] ${l.texto}`).join("\n");
  navigator.clipboard.writeText(txt).then(() => mostrarNotificacao("Logs copiados!", "success"))
    .catch(() => mostrarNotificacao("Erro ao copiar", "danger"));
}

function baixarLogs() {
  const txt = logBuffer.map((l) => `[${new Date(l.ts).toLocaleTimeString("pt-BR")}] ${l.texto}`).join("\n");
  const blob = new Blob([txt], { type: "text/plain" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = logTitulo.replace(/[^a-z0-9]+/gi, "-").toLowerCase() + ".log";
  a.click();
  URL.revokeObjectURL(a.href);
}

function limparLogs() { logBuffer = []; renderLog(); }

// ─── Rebuild (stream de texto via fetch) ───
async function rebuild(appId, svcId) {
  if (!confirm(`Rebuildar a imagem de ${appId}/${svcId}? (docker compose up -d --build)`)) return;
  abrirModal(`Rebuild: ${appId} / ${svcId}`);
  if (logSource) { logSource.close(); logSource = null; }
  logBuffer = []; renderLog();
  pushLog("stdout", "Iniciando rebuild...");
  try {
    const res = await fetch("/api/rebuild", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ appId, svcId }) });
    if (!res.ok) { const j = await res.json().catch(() => ({})); return pushLog("stderr", j.erro || "Falha no rebuild"); }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let resto = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      resto += dec.decode(value, { stream: true });
      const linhas = resto.split("\n");
      resto = linhas.pop();
      for (const ln of linhas) pushLog("stdout", ln);
    }
    if (resto) pushLog("stdout", resto);
    mostrarNotificacao(`Rebuild de ${appId}/${svcId} concluído`, "success");
  } catch (e) {
    pushLog("stderr", "Erro: " + e.message);
  }
}
function pushLog(tipo, texto) {
  if (texto === undefined) return;
  const l = { tipo, texto, ts: Date.now() };
  logBuffer.push(l); appendLogLine(l);
}

// ─── Toasts ───
function mostrarNotificacao(msg, tipo = "info") {
  const cont = document.getElementById("notificacoes");
  const n = document.createElement("div");
  n.className = `notificacao notif-${tipo}`;
  n.textContent = msg;
  cont.appendChild(n);
  setTimeout(() => { n.style.transition = "opacity .3s, transform .3s"; n.style.opacity = "0"; n.style.transform = "translateX(110%)"; setTimeout(() => n.remove(), 300); }, 4000);
}

// ─── Utils ───
function escapeHtml(str) {
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
