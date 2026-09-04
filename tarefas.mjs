/**
 * TAREFAS AGENDADAS — Server Manager
 *
 * O Manager nasceu para SERVIÇOS: processos longos, com porta, que ficam de pé.
 * Uma rotina mensal não é nada disso — não tem porta, roda por alguns minutos e
 * termina. Encaixá-la em `servicos` quebraria de imediato: `iniciarServico` mata
 * quem estiver na `svc.porta` antes de subir, e uma tarefa sem porta faria isso
 * com `undefined`.
 *
 * Então tarefa é um conceito próprio, com o mínimo que ela exige:
 *
 *   quando roda   → dia do mês + hora, porque é disso que as rotinas fiscais
 *                   precisam ("todo dia 25"). Não há cron aqui de propósito: uma
 *                   string de cinco campos seria mais poderosa e menos legível
 *                   para quem abre o painel, e o Manager não tem dependências
 *                   para interpretá-la.
 *   o que ficou   → última execução, código de saída e log, em disco. Estado em
 *                   memória não sobrevive ao restart do Manager, e o Manager
 *                   reinicia sozinho pelo runner — sem persistir, um restart no
 *                   dia 25 rodaria a tarefa de novo.
 *
 * A JANELA DE RECUPERAÇÃO. A tarefa não roda "às 06:00 do dia 25": ela roda na
 * primeira verificação a partir do dia 25 às 06:00 que encontre o mês ainda não
 * feito. Se a máquina estiver desligada naquela hora, ela roda quando voltar —
 * no dia 26, 27. Com horário exato, um desligamento de dez minutos custaria a
 * competência inteira, e ninguém descobriria antes do cliente reclamar.
 *
 * SUCESSO É O QUE FECHA O MÊS, não a tentativa. Uma execução que sai com código
 * diferente de zero (pasta de rede fora do ar, banco caído) NÃO marca o mês como
 * feito — ela é retentada, com uma folga de uma hora entre tentativas para não
 * transformar uma falha permanente em laço de um minuto.
 */

import fs from "node:fs";
import path from "node:path";
import { spawn, exec } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARQUIVO_ESTADO = path.join(__dirname, "tarefas-estado.json");

/** Folga entre tentativas depois de uma execução que falhou. */
const RETENTAR_APOS_MS = 60 * 60 * 1000;
const INTERVALO_VERIFICACAO_MS = 60 * 1000;
const MAX_LINHAS_LOG = 500;

/** id → { proc, logs, iniciadoEm, timeoutId } */
const rodando = new Map();

// ─── Estado em disco ────────────────────────────────────────────────────────

function lerEstado() {
  try {
    return JSON.parse(fs.readFileSync(ARQUIVO_ESTADO, "utf8"));
  } catch {
    // Arquivo ausente na primeira execução, ou corrompido. Nos dois casos o
    // estado vazio é a resposta certa: a tarefa roda e o arquivo se refaz.
    return {};
  }
}

function gravarEstado(estado) {
  try {
    fs.writeFileSync(ARQUIVO_ESTADO, JSON.stringify(estado, null, 2), "utf8");
  } catch (e) {
    console.error("[Tarefas] Não foi possível gravar o estado:", e.message);
  }
}

function estadoDe(id) {
  return lerEstado()[id] || null;
}

function registrarExecucao(id, dados) {
  const estado = lerEstado();
  estado[id] = { ...(estado[id] || {}), ...dados };
  gravarEstado(estado);
}

// ─── Quando roda ────────────────────────────────────────────────────────────

const mesmoMes = (ts, agora) => {
  if (!ts) return false;
  const d = new Date(ts);
  return d.getFullYear() === agora.getFullYear() && d.getMonth() === agora.getMonth();
};

/**
 * A tarefa deve rodar agora?
 *
 * Devolve `{ deve, motivo }` — o motivo alimenta o painel, para "não rodou"
 * nunca ser uma resposta muda.
 */
export function avaliar(tarefa, estadoTarefa, agora = new Date()) {
  if (tarefa.habilitada === false) return { deve: false, motivo: "desabilitada" };

  const dia = Number(tarefa.dia || 1);
  const hora = Number(tarefa.hora ?? 6);

  if (agora.getDate() < dia) {
    return { deve: false, motivo: `aguardando o dia ${dia}` };
  }
  // A hora só é exigida na primeira oportunidade. Recuperando um dia perdido,
  // qualquer hora serve — executar vale mais do que respeitar o horário.
  if (agora.getDate() === dia && agora.getHours() < hora) {
    return { deve: false, motivo: `aguardando ${String(hora).padStart(2, "0")}:00` };
  }

  const ultima = estadoTarefa?.ultimaExecucao;
  const ok = estadoTarefa?.ultimoCodigo === 0;

  if (mesmoMes(ultima, agora) && ok) {
    return { deve: false, motivo: "já executada neste mês" };
  }
  if (ultima && Date.now() - ultima < RETENTAR_APOS_MS) {
    const min = Math.ceil((RETENTAR_APOS_MS - (Date.now() - ultima)) / 60000);
    return { deve: false, motivo: `falhou — nova tentativa em ${min} min` };
  }

  return { deve: true, motivo: mesmoMes(ultima, agora) ? "retentando após falha" : "no horário" };
}

/** Próxima data prevista, para o painel dizer quando é. */
export function proximaExecucao(tarefa, estadoTarefa, agora = new Date()) {
  const dia = Number(tarefa.dia || 1);
  const hora = Number(tarefa.hora ?? 6);
  const feitoNesteMes = mesmoMes(estadoTarefa?.ultimaExecucao, agora) && estadoTarefa?.ultimoCodigo === 0;

  const mes = feitoNesteMes || agora.getDate() > dia ? agora.getMonth() + 1 : agora.getMonth();
  const alvo = new Date(agora.getFullYear(), mes, dia, hora, 0, 0);
  // Dia 31 num mês de 30 cai no dia 1º do mês seguinte por overflow do Date.
  // Aceitável e previsível; documentado aqui para não parecer defeito.
  return alvo.getTime();
}

// ─── Execução ───────────────────────────────────────────────────────────────

export function estaRodando(id) {
  return rodando.has(id);
}

export function logsDe(id) {
  const vivo = rodando.get(id);
  if (vivo) return vivo.logs;
  return estadoTarefaLogs(id);
}

function estadoTarefaLogs(id) {
  return estadoDe(id)?.ultimoLog || [];
}

/**
 * Dispara a tarefa. Não lança — devolve `{ ok, erro? }`.
 *
 * O comando roda inteiro no shell, igual aos serviços: preserva caminho com
 * espaço e permite comando composto.
 */
export function executar(tarefa, id, origem = "agendador") {
  if (rodando.has(id)) return { ok: false, erro: "A tarefa já está em execução." };

  const cwd = path.resolve(__dirname, tarefa.cwd);
  if (!fs.existsSync(cwd)) return { ok: false, erro: `Diretório não encontrado: ${cwd}` };

  const logs = [];
  const empilhar = (tipo, texto) => {
    logs.push({ ts: Date.now(), tipo, texto });
    while (logs.length > MAX_LINHAS_LOG) logs.shift();
  };

  empilhar("info", `Iniciada por ${origem}: ${tarefa.comando}`);

  const proc = spawn(tarefa.comando, {
    cwd,
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, FORCE_COLOR: "0", ...(tarefa.env || {}) },
  });

  const consumir = (fluxo, tipo) => {
    fluxo.on("data", (d) => {
      for (const linha of d.toString().split("\n")) {
        if (linha.trim()) empilhar(tipo, linha);
      }
    });
  };
  consumir(proc.stdout, "stdout");
  consumir(proc.stderr, "stderr");

  // Uma tarefa travada seguraria o slot para sempre e o mês nunca fecharia.
  // O teto é generoso porque a rodada do DARF conversa com a Receita, que é
  // lenta; o que ele impede é o pendurado eterno, não a demora normal.
  const limiteMs = Number(tarefa.timeoutMin || 30) * 60 * 1000;
  const timeoutId = setTimeout(() => {
    empilhar("stderr", `Tempo esgotado (${tarefa.timeoutMin || 30} min) — encerrando.`);
    try {
      exec(`taskkill /PID ${proc.pid} /T /F`, () => {});
    } catch {
      /* o exit handler registra o resultado de qualquer forma */
    }
  }, limiteMs);

  const iniciadoEm = Date.now();
  rodando.set(id, { proc, logs, iniciadoEm, timeoutId });

  proc.on("exit", (codigo) => {
    clearTimeout(timeoutId);
    const duracaoMs = Date.now() - iniciadoEm;
    empilhar("exit", `Processo encerrado (code ${codigo}) em ${Math.round(duracaoMs / 1000)}s`);
    rodando.delete(id);

    registrarExecucao(id, {
      ultimaExecucao: iniciadoEm,
      ultimoTermino: Date.now(),
      ultimoCodigo: codigo,
      ultimaDuracaoMs: duracaoMs,
      ultimaOrigem: origem,
      // O log inteiro vai para o disco: é o que responde "o que aconteceu no
      // dia 25?" quando alguém pergunta no dia 30, muito depois de o processo
      // ter morrido e o buffer em memória ter sumido.
      ultimoLog: logs.slice(-MAX_LINHAS_LOG),
    });

    console.log(
      `[Tarefas] "${id}" terminou com code ${codigo} em ${Math.round(duracaoMs / 1000)}s (${origem}).`
    );
  });

  proc.on("error", (e) => {
    clearTimeout(timeoutId);
    empilhar("stderr", `Falha ao iniciar: ${e.message}`);
    rodando.delete(id);
    registrarExecucao(id, {
      ultimaExecucao: iniciadoEm,
      ultimoTermino: Date.now(),
      ultimoCodigo: -1,
      ultimaDuracaoMs: Date.now() - iniciadoEm,
      ultimaOrigem: origem,
      ultimoLog: logs.slice(-MAX_LINHAS_LOG),
    });
  });

  return { ok: true, pid: proc.pid };
}

export function parar(id) {
  const vivo = rodando.get(id);
  if (!vivo) return { ok: false, erro: "A tarefa não está em execução." };
  try {
    clearTimeout(vivo.timeoutId);
    exec(`taskkill /PID ${vivo.proc.pid} /T /F`, () => {});
    return { ok: true };
  } catch (e) {
    return { ok: false, erro: e.message };
  }
}

// ─── Leitura para o painel ──────────────────────────────────────────────────

export function listar(registro) {
  const tarefas = registro.tarefas || {};
  const estado = lerEstado();
  const agora = new Date();

  return Object.entries(tarefas).map(([id, t]) => {
    const e = estado[id] || null;
    const vivo = rodando.get(id);
    return {
      id,
      nome: t.nome || id,
      descricao: t.descricao || "",
      appId: t.appId || null,
      comando: t.comando,
      cwd: t.cwd,
      dia: Number(t.dia || 1),
      hora: Number(t.hora ?? 6),
      habilitada: t.habilitada !== false,
      rodando: !!vivo,
      rodandoDesde: vivo?.iniciadoEm || null,
      ultimaExecucao: e?.ultimaExecucao || null,
      ultimoTermino: e?.ultimoTermino || null,
      ultimoCodigo: e?.ultimoCodigo ?? null,
      ultimaDuracaoMs: e?.ultimaDuracaoMs || null,
      ultimaOrigem: e?.ultimaOrigem || null,
      proximaExecucao: proximaExecucao(t, e, agora),
      situacao: vivo ? { deve: false, motivo: "em execução" } : avaliar(t, e, agora),
    };
  });
}

// ─── O laço ─────────────────────────────────────────────────────────────────

let timer = null;

export function iniciarLoop(carregarRegistro) {
  if (timer) return;

  const verificar = () => {
    let registro;
    try {
      registro = carregarRegistro();
    } catch (e) {
      console.error("[Tarefas] Registro ilegível:", e.message);
      return;
    }

    const tarefas = registro.tarefas || {};
    const agora = new Date();

    for (const [id, t] of Object.entries(tarefas)) {
      if (rodando.has(id)) continue;
      const { deve, motivo } = avaliar(t, estadoDe(id), agora);
      if (!deve) continue;

      console.log(`[Tarefas] Disparando "${id}" (${motivo}).`);
      const r = executar(t, id, "agendador");
      if (!r.ok) console.error(`[Tarefas] "${id}" não iniciou: ${r.erro}`);
    }
  };

  timer = setInterval(verificar, INTERVALO_VERIFICACAO_MS);
  // Uma verificação logo na subida: se o Manager estava fora do ar no horário,
  // a tarefa atrasada roda assim que ele volta, sem esperar o próximo minuto.
  setTimeout(verificar, 5000);

  const quantas = Object.keys(carregarRegistro().tarefas || {}).length;
  console.log(`[Tarefas] Agendador ativo — ${quantas} tarefa(s) registrada(s).`);
}

/** Liga/desliga, gravando no registro para sobreviver ao restart. */
export function alternar(id, habilitada) {
  const arquivo = path.join(__dirname, "port-registry.json");
  const registro = JSON.parse(fs.readFileSync(arquivo, "utf8"));
  if (!registro.tarefas?.[id]) return { ok: false, erro: `Tarefa "${id}" não encontrada.` };
  registro.tarefas[id].habilitada = !!habilitada;
  fs.writeFileSync(arquivo, JSON.stringify(registro, null, 2), "utf8");
  return { ok: true };
}
