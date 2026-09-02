// =============================================================================
// cache-git-creds.mjs — garante que cada remote git vigiado tenha credencial de
// ESCRITA no Gerenciador de Credenciais do Windows (persiste no reboot), para o
// painel conseguir enviar sem janela de login — ele roda headless e não tem
// ninguém para responder um prompt.
//
// Pré-requisito (já aplicado): git config --global credential.useHttpPath true
//   → guarda credencial por-caminho, cobrindo repos de contas/orgs diferentes.
//   É também o motivo de o mesmo token precisar ser gravado uma vez por repo.
//
// DOIS MODOS
//
//   node cache-git-creds.mjs
//     Diagnóstico. Faz `fetch` e `push --dry-run` em cada remote e diz o estado
//     de cada um. Onde faltar credencial, o Git Credential Manager abre a janela
//     de login (uma por remote). Não envia commit nenhum.
//
//   node cache-git-creds.mjs --token [--owner=Bruno-1990]
//     Grava um Personal Access Token de uma vez em TODOS os remotes do dono
//     indicado (padrão: Bruno-1990), sem abrir janela. Depois de gravar, rode o
//     modo de diagnóstico para conferir.
//
//     O token nunca vem por argumento de linha de comando — argumento fica no
//     histórico do shell e na lista de processos. Ele vem, nesta ordem, de:
//       --arquivo=<caminho>      arquivo de texto, apagado assim que lido
//       GH_TOKEN / GITHUB_TOKEN  variável de ambiente
//       prompt de digitação oculta, quando há terminal de verdade
//
// Buscar NÃO prova que enviar funciona: repo público busca sem login nenhum, e
// nesse caso nada chega a ser guardado. Por isso o teste é o `push --dry-run`.
// =============================================================================
import { execSync } from "node:child_process";
import { readFileSync, unlinkSync } from "node:fs";
import readline from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const reg = JSON.parse(readFileSync(path.join(__dirname, "port-registry.json"), "utf8"));

const alvos = [
  ...Object.entries(reg.apps || {}).map(([id, a]) => ({ id, diretorio: a.diretorio })),
  ...(reg.reposVigiados || []),
];

const args = process.argv.slice(2);
const MODO_TOKEN = args.includes("--token");
const DONO = (args.find((a) => a.startsWith("--owner=")) || "--owner=Bruno-1990").split("=")[1];

// ─── Remotes de todos os repos vigiados ──────────────────────────────────────
function reposComRemotes() {
  const lista = [];
  for (const alvo of alvos) {
    if (!alvo.diretorio) continue;
    const dir = path.resolve(__dirname, alvo.diretorio);
    try { execSync(`git -C "${dir}" rev-parse --is-inside-work-tree`, { stdio: "ignore" }); }
    catch { continue; } // não é repo git
    let remotes = [];
    try {
      remotes = execSync(`git -C "${dir}" remote`, { encoding: "utf8" })
        .split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    } catch { /* sem remote */ }
    if (!remotes.length) continue;
    lista.push({ id: alvo.id, dir, remotes });
  }
  return lista;
}

function urlDoRemote(dir, rem) {
  try { return execSync(`git -C "${dir}" remote get-url ${rem}`, { encoding: "utf8" }).trim(); }
  catch { return ""; }
}

// Para onde este remote empurraria: o branch do upstream quando o upstream é
// deste mesmo remote (caso do centria, em local/dev -> base/main), senão o branch
// atual. Sem refspec explícita o `push --dry-run` morre em "upstream branch does
// not match" ou "no upstream branch" — que não são falta de credencial.
function refspecDe(dir, rem) {
  let branch = "";
  try { branch = execSync(`git -C "${dir}" rev-parse --abbrev-ref HEAD`, { encoding: "utf8" }).trim(); }
  catch { return null; }
  if (!branch || branch === "HEAD") return null;
  try {
    const up = execSync(`git -C "${dir}" rev-parse --abbrev-ref @{upstream}`,
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const barra = up.indexOf("/");
    if (barra > 0 && up.slice(0, barra) === rem) return `HEAD:${up.slice(barra + 1)}`;
  } catch { /* sem upstream */ }
  return `HEAD:${branch}`;
}

// ─── Modo --token: grava o PAT direto, sem janela ────────────────────────────
// De onde o token pode vir, em ordem. Nenhuma delas o coloca na linha de comando:
// argumento de processo aparece no histórico do shell e na lista de processos.
//
//   --arquivo=<caminho>  arquivo de texto com o token na primeira linha; apagado
//                        assim que lido. Serve onde não há terminal interativo.
//   GH_TOKEN / GITHUB_TOKEN  variável de ambiente da sessão.
//   prompt oculto        só quando a entrada é um terminal de verdade.
//
// Sem TTY e sem nenhuma das outras, o prompt não tem como funcionar: o readline
// recebe EOF na hora e o processo morre em "unsettled top-level await", sem
// explicar nada. Por isso a checagem explícita.
function lerToken() {
  const arg = process.argv.slice(2).find((a) => a.startsWith("--arquivo="));
  if (arg) {
    const caminho = arg.slice("--arquivo=".length).replace(/^"|"$/g, "");
    const bruto = readFileSync(caminho, "utf8").split(/\r?\n/)[0].trim();
    try { unlinkSync(caminho); console.log(`Arquivo ${caminho} lido e apagado.`); }
    catch { console.log(`ATENÇÃO: não consegui apagar ${caminho} — apague à mão, tem o token dentro.`); }
    return Promise.resolve(bruto);
  }
  const doAmbiente = (process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "").trim();
  if (doAmbiente) { console.log("Token lido da variável de ambiente."); return Promise.resolve(doAmbiente); }

  if (!process.stdin.isTTY) {
    console.log(
      "\nSem terminal interativo aqui, então não dá para pedir o token com digitação oculta.\n" +
      "Duas saídas, e nenhuma delas põe o token no histórico do shell:\n\n" +
      "  1) Salve o token num arquivo de texto (Bloco de Notas serve) e rode:\n" +
      "       node cache-git-creds.mjs --token --arquivo=C:\\caminho\\token.txt\n" +
      "     O arquivo é apagado assim que for lido.\n\n" +
      "  2) Ou rode este mesmo comando numa janela normal do PowerShell/cmd,\n" +
      "     onde o prompt oculto funciona."
    );
    return Promise.resolve("");
  }
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    let mudo = false;
    rl._writeToOutput = (s) => { if (!mudo) rl.output.write(s); };
    rl.question("Cole o token e dê Enter: ", (resposta) => {
      rl.close(); process.stdout.write("\n"); resolve(resposta.trim());
    });
    mudo = true;
  });
}

function gravarCredencial(url, usuario, token) {
  // `git credential approve` fala com o helper configurado (o "manager"), que
  // grava no cofre do Windows. A chave inclui o path porque useHttpPath=true.
  const u = new URL(url);
  const entrada = [
    `protocol=${u.protocol.replace(":", "")}`,
    `host=${u.host}`,
    `path=${u.pathname.replace(/^\//, "")}`,
    `username=${usuario}`,
    `password=${token}`,
    "", "",
  ].join("\n");
  execSync("git credential approve", { input: entrada, stdio: ["pipe", "ignore", "inherit"] });
}

async function modoToken() {
  const repos = reposComRemotes();
  const alvosDoDono = [];
  for (const r of repos) {
    for (const rem of r.remotes) {
      const url = urlDoRemote(r.dir, rem);
      if (!/^https:\/\/github\.com\//i.test(url)) continue;
      const dono = url.replace(/^https:\/\/github\.com\//i, "").split("/")[0];
      if (dono.toLowerCase() !== DONO.toLowerCase()) continue;
      alvosDoDono.push({ id: r.id, rem, url });
    }
  }
  if (!alvosDoDono.length) {
    console.log(`Nenhum remote de "${DONO}" entre os repos vigiados. Confira o --owner=.`);
    return;
  }

  console.log(`\nToken será gravado para ${alvosDoDono.length} remote(s) de "${DONO}":`);
  for (const a of alvosDoDono) console.log(`   ${a.id}/${a.rem}  ${a.url}`);
  const token = await lerToken();
  if (!token) { console.log("Sem token — nada gravado."); return; }

  let gravados = 0;
  for (const a of alvosDoDono) {
    try { gravarCredencial(a.url, DONO, token); console.log(`   ${a.id}/${a.rem}: gravado`); gravados++; }
    catch (e) { console.log(`   ${a.id}/${a.rem}: FALHOU — ${(e.message || "").split("\n")[0]}`); }
  }
  console.log(`\n${gravados} credencial(is) gravada(s) no Gerenciador de Credenciais do Windows.`);
  console.log("Confira agora com: node cache-git-creds.mjs");
}

// ─── Modo diagnóstico ────────────────────────────────────────────────────────
// Separa os quatro motivos de falha. Só o primeiro se resolve com token; tratar
// todos como "sem credencial" mandava para o lado errado.
const CATEGORIAS = [
  { re: /Invalid username or token|Authentication failed|could not read (Username|Password)|unable to get password|Cannot prompt/i,
    tag: "credencial", dica: "sem credencial de escrita válida — é isto que o token resolve" },
  { re: /Permission to .* denied|403/i,
    tag: "permissão", dica: "a conta não tem acesso de escrita neste repo — token nenhum contorna" },
  { re: /non-fast-forward|behind its remote|\[rejected\]/i,
    tag: "atrás do remoto", dica: "há commit no remoto que não está aqui — trazer antes de enviar" },
];
function classificar(saida) {
  for (const c of CATEGORIAS) if (c.re.test(saida)) return c;
  return { tag: "outro", dica: "ver a saída do git acima" };
}

function diagnostico() {
  let ok = 0, pulados = 0;
  const porCategoria = {};
  const repos = reposComRemotes();
  pulados = alvos.filter((a) => a.diretorio).length - repos.length;

  for (const r of repos) {
    process.stdout.write(`\n== ${r.id}  (${r.dir}) ==\n`);
    for (const rem of r.remotes) {
      try {
        execSync(`git -C "${r.dir}" fetch --prune --quiet ${rem}`, { stdio: "inherit" });
        console.log(`   ${rem}: busca OK`);
      } catch (e) {
        const cat = classificar(`${e.message}\n${e.stderr || ""}`);
        console.log(`   ${rem}: busca FALHOU (${cat.tag})`);
        (porCategoria[cat.tag] ||= []).push({ alvo: `${r.id}/${rem} (busca)`, dica: cat.dica });
        continue;
      }
      const refspec = refspecDe(r.dir, rem);
      if (!refspec) { console.log(`   ${rem}: sem branch para testar envio (detached HEAD)`); continue; }
      try {
        execSync(`git -C "${r.dir}" push --dry-run --quiet ${rem} ${refspec}`, { stdio: "inherit" });
        console.log(`   ${rem}: envio OK — credencial de escrita válida`);
        ok++;
      } catch (e) {
        const cat = classificar(`${e.message}\n${e.stderr || ""}`);
        console.log(`   ${rem}: envio FALHOU (${cat.tag})`);
        (porCategoria[cat.tag] ||= []).push({ alvo: `${r.id}/${rem}`, dica: cat.dica });
      }
    }
  }

  console.log(`\n${"=".repeat(70)}`);
  console.log(`Resumo: ${ok} remote(s) prontos para enviar · ${pulados} repo(s) sem git/remote.`);
  for (const [tag, itens] of Object.entries(porCategoria)) {
    console.log(`\n${tag.toUpperCase()} (${itens.length}) — ${itens[0].dica}`);
    for (const i of itens) console.log(`   ${i.alvo}`);
  }
  if (porCategoria["credencial"]) {
    console.log(`\nPara resolver os de credencial de uma vez, sem janela:`);
    console.log(`   node cache-git-creds.mjs --token`);
  }
  console.log("\nAs credenciais ficam no Gerenciador de Credenciais do Windows — persistem no reboot.");
}

if (MODO_TOKEN) await modoToken();
else diagnostico();
