// =============================================================================
// cache-git-creds.mjs — autentica UMA vez cada remote git vigiado, para o
// Git Credential Manager (helper "manager") salvar a credencial no Gerenciador
// de Credenciais do Windows (persiste no reboot).
//
// Pré-requisito (já aplicado): git config --global credential.useHttpPath true
//   → guarda credencial por-caminho, cobrindo repos de contas/orgs diferentes.
//
// Cobre os apps do registro E os repos de `reposVigiados`, e percorre TODOS os
// remotes de cada repo — não só o `origin`. Repos como o centria (remotes `base`
// e `origin`) e o webapp (remote `webapp`) ficavam de fora quando isto aqui só
// rodava `git fetch` sem argumento, e o painel exibia números velhos calados.
//
// Uso:  node cache-git-creds.mjs
//   As janelas de login aparecem UMA vez por remote ainda não cacheado.
//   Escolha a conta certa em cada uma. Depois disso, o painel busca em silêncio.
// =============================================================================
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const reg = JSON.parse(readFileSync(path.join(__dirname, "port-registry.json"), "utf8"));

const alvos = [
  ...Object.entries(reg.apps || {}).map(([id, a]) => ({ id, diretorio: a.diretorio })),
  ...(reg.reposVigiados || []),
];

let ok = 0, falhou = 0, pulados = 0;
const pendentes = [];
for (const alvo of alvos) {
  if (!alvo.diretorio) continue;
  const dir = path.resolve(__dirname, alvo.diretorio);
  try { execSync(`git -C "${dir}" rev-parse --is-inside-work-tree`, { stdio: "ignore" }); }
  catch { pulados++; continue; } // não é repo git

  let remotes = [];
  try {
    remotes = execSync(`git -C "${dir}" remote`, { encoding: "utf8" })
      .split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } catch { /* sem remote */ }
  if (!remotes.length) { pulados++; continue; }

  process.stdout.write(`\n== ${alvo.id}  (${dir}) ==\n`);
  for (const rem of remotes) {
    // Buscar NAO prova que enviar vai funcionar: repo publico busca sem login
    // nenhum, e nesse caso nada fica guardado. O `push --dry-run` e o que obriga
    // o GCM a autenticar de verdade e gravar a credencial de escrita — sem enviar
    // commit algum. E por isso que o painel achava o repo "verificado" e mesmo
    // assim o botao Enviar morria sem credencial.
    try {
      execSync(`git -C "${dir}" fetch --prune --quiet ${rem}`, { stdio: "inherit" });
      console.log(`   ${rem}: busca OK`);
    } catch (e) {
      console.log(`   ${rem}: busca FALHOU — ${(e.message || "").split("\n")[0]}`);
      pendentes.push(`${alvo.id}/${rem} (busca)`);
      falhou++;
      continue;
    }
    try {
      execSync(`git -C "${dir}" push --dry-run --quiet ${rem}`, { stdio: "inherit" });
      console.log(`   ${rem}: envio OK — credencial salva/validada`);
      ok++;
    } catch (e) {
      console.log(`   ${rem}: envio FALHOU — ${(e.message || "").split("\n")[0]}`);
      pendentes.push(`${alvo.id}/${rem} (envio)`);
      falhou++;
    }
  }
}
console.log(`\nResumo: ${ok} remote(s) prontos para enviar · ${falhou} falharam · ${pulados} repo(s) sem git/remote.`);
if (pendentes.length) console.log(`Ainda sem credencial: ${pendentes.join(", ")}`);
console.log("As credenciais ficam no Gerenciador de Credenciais do Windows — persistem no reboot.");
