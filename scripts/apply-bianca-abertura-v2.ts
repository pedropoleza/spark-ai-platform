/**
 * Bianca / agente de TRAFEGO PAGO (17860a86): abertura e work permit nas palavras
 * da propria Bia. Ticket #320 (Five Rings), despacho d-a304d7, aprovado pelo
 * Pedro em 01/10.
 *
 * Por que a saudacao "nao mudava" (a queixa do ticket):
 *  1. A Bia editou `personality.greeting_style` na area de IA. Esse campo so e
 *     lido quando `isFirstTurn` e verdadeiro (sales-prompt-builder.ts:231), e em
 *     producao ele nunca e: o historico vem do Spark Leads ja com a mensagem do
 *     proprio lead, entao `priorTurnCount` e no minimo 1 (queue-processor.ts:1913).
 *  2. A abertura que valia de verdade era a secao "# ABERTURA" deste prompt, que
 *     mandava se apresentar como Manu e perguntar "o que te chamou atencao no
 *     conteudo dela?". Medido nas 8 primeiras respostas reais: 3 perguntaram
 *     "foi algum conteudo da Bianca, indicacao de alguem?" e 1 listou "green
 *     card, cidadania, work permit" (copiado do EXEMPLO 5).
 *
 * LIMITE CONHECIDO (precisa de decisao do Pedro, e codigo da frota): o "Oi!" da
 * abertura nao chega ao lead. Pelo mesmo `priorTurnCount >= 1`, o runtime injeta
 * "REGRA ABSOLUTA: NAO comece com oi" e o `sanitizeAgentMessage` remove "Oi!" do
 * inicio de cada bolha (response-sanitizer.ts, padrao da linha 21). O resto da
 * abertura passa intacto.
 *
 * NAO mexe em `agents.status` (segue inactive) nem em `personality.greeting_style`.
 * Backup em _dados_clientes/five-rings/ ANTES de qualquer escrita.
 *
 *   npx tsx scripts/apply-bianca-abertura-v2.ts --dry
 *   npx tsx scripts/apply-bianca-abertura-v2.ts
 *   npx tsx scripts/apply-bianca-abertura-v2.ts --revert=_dados_clientes/five-rings/<arquivo>.json
 */
import { config as env } from "dotenv";
import { resolve } from "path";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
env({ path: resolve(__dirname, "..", ".env.local") });
import { createAdminClient } from "@/lib/supabase/admin";

const AGENT_ID = "17860a86-ace9-4299-9328-2452151348a0";
const CONFIG_ID = "8c0d919c-697a-4099-8a88-5dce9c8deba0";
const DIR_BACKUP = resolve(__dirname, "..", "_dados_clientes", "five-rings");
const DRY = process.argv.includes("--dry");
const REVERT = process.argv.find((a) => a.startsWith("--revert="))?.slice(9);

// Textos da Bia, copiados como ela mandou (abertura 10/09, work permit 14/09).
const ABERTURA_1 = "Oi! Que bom que você entrou em contato";
const ABERTURA_2 = "Me conta uma coisa: em qual estado dos EUA você mora hoje?";
const WORK_PERMIT = "O único requisito para essa carreira é ter permissão de trabalho aqui nos eua… você já tem?";

/* ── custom_instructions: corpo novo de cada secao ─────────────────────── */
const SECOES: Array<[string, string]> = [
  ["# ABERTURA",
    `Primeira mensagem = EXATAMENTE 2 bolhas: "${ABERTURA_1}" e "${ABERTURA_2}". NÃO se apresente pelo nome na abertura (perguntaram? é a Manu, da equipe da Bianca). Lead já disse o estado? NÃO repergunte: reaja e siga pro work permit. Trouxe pergunta? Responda curto antes.`],
  ["# PERGUNTA-OURO",
    `A 1ª pergunta é SEMPRE o estado (vai na abertura). NUNCA pergunte se a pessoa veio por indicação, anúncio ou conteúdo, nem como chegou até a gente. A pergunta-ouro vem DEPOIS de estado, work permit e profissão: "o que mais te chamou atenção nessa carreira?", gancho emocional, não formulário. NUNCA repita a mesma pergunta-ouro; se o lead desviou ou ignorou, NÃO insista: reflita o que ele trouxe e SIGA.`],
  ["# FUNIL (comprimido)",
    `ESTADO (1ª pergunta, na abertura) → WORK PERMIT (gate) → PROFISSÃO → MOTIVAÇÃO (pergunta-ouro) → espelho-da-dor → convite ancorado. NUNCA pergunte se veio por indicação ou conteúdo. Profissão e motivação = 1 turno cada, não vire entrevista. 1 pergunta FECHADA por vez. A cada ~4-5 turnos, ou quando o lead compartilhar algo pessoal, responda com PURA reação/espelhamento e NENHUMA pergunta.`],
];
const WP_ANTIGO = `Nunca pergunte sozinho: "fica tranquila, é só pra eu te orientar certinho, porque a licença depende disso: você já tem sua permissão de trabalho aqui, o work permit?".`;
const WP_NOVO = `Pergunte EXATAMENTE assim: "${WORK_PERMIT}". PROIBIDO listar "green card, cidadania" ou tipo de documento.`;

/* ── conversation_examples ─────────────────────────────────────────────── */
const EX_TROCAS: Array<[string, string]> = [
  [
    `EXEMPLO 1 — abertura vinda do anúncio\nLEAD: "Sim! Quero me tornar um Agente Financeiro nos Estados Unidos,"\nMANU: "Oi! que bom te ver por aqui 🥰 sou a Manu, do time da Bianca"\n"me conta, vc tá em qual estado?"`,
    `EXEMPLO 1: abertura vinda do anúncio (texto da Bia)\nLEAD: "Sim! Quero me tornar um Agente Financeiro nos Estados Unidos,"\nMANU: "${ABERTURA_1}"\n"${ABERTURA_2}"\n(NÃO se apresenta pelo nome. NÃO pergunta se veio por indicação ou conteúdo.)`,
  ],
  [
    `MANU: "e vc já tem autorização pra trabalhar aí? (green card, cidadania, work permit)"`,
    `MANU: "${WORK_PERMIT}"`,
  ],
  [
    `(NUNCA pedir SSN, número de visto ou foto de documento. NUNCA orientar sobre imigração.)`,
    `(NUNCA pedir SSN, número de visto ou foto de documento. NUNCA listar green card ou cidadania. NUNCA orientar sobre imigração.)`,
  ],
  [
    `CERTO: "haha falo assim mesmo 😊 me conta, o que te chamou atenção no conteúdo dela?"`,
    `CERTO: "haha falo assim mesmo 😊 me conta uma coisa: em qual estado dos EUA você mora hoje?"`,
  ],
];

function trocaCorpo(ci: string, header: string, corpo: string): string {
  const ini = ci.indexOf(`${header}\n`);
  if (ini < 0) throw new Error(`secao "${header}" nao encontrada: o prompt mudou, conferir a mao`);
  const abre = ini + header.length + 1;
  const fecha = ci.indexOf("\n\n", abre);
  if (fecha < 0) throw new Error(`fim da secao "${header}" nao encontrado`);
  return ci.slice(0, abre) + corpo + ci.slice(fecha);
}

async function main() {
  const sb = createAdminClient();
  const { data: cfg, error } = await sb
    .from("agent_configs")
    .select("id, custom_instructions, conversation_examples, personality, updated_at")
    .eq("agent_id", AGENT_ID).single();
  if (error || !cfg) { console.error("config nao encontrada:", error?.message); process.exit(1); }
  if (cfg.id !== CONFIG_ID) { console.error(`config inesperada: ${cfg.id}`); process.exit(1); }

  if (REVERT) {
    const bk = JSON.parse(readFileSync(resolve(__dirname, "..", REVERT), "utf8"));
    if (bk.agent_id !== AGENT_ID) { console.error("backup de outro agente"); process.exit(1); }
    if (DRY) { console.log("(dry) restauraria ci/ex do backup", bk.captured_at); process.exit(0); }
    const { error: e } = await sb.from("agent_configs").update({
      custom_instructions: bk.custom_instructions,
      conversation_examples: bk.conversation_examples,
      updated_at: new Date().toISOString(),
    }).eq("agent_id", AGENT_ID);
    if (e) { console.error("revert falhou:", e.message); process.exit(1); }
    console.log(`REVERTIDO verbatim a partir de ${REVERT}`);
    process.exit(0);
  }

  // Nenhum travessao no texto novo (regra do OS).
  const textoNovo = [...SECOES.map((s) => s[1]), WP_NOVO, ...EX_TROCAS.map((t) => t[1])].join("\n");
  if (/[—–]/.test(textoNovo)) { console.error("texto novo contem travessao"); process.exit(1); }

  const ciAntes = cfg.custom_instructions || "";
  const exAntes = cfg.conversation_examples || "";
  if (ciAntes.includes(ABERTURA_2) && exAntes.includes(WORK_PERMIT)) {
    console.log("ja aplicado, nada a fazer"); process.exit(0);
  }

  let ci = ciAntes;
  for (const [h, corpo] of SECOES) ci = trocaCorpo(ci, h, corpo);
  if (!ci.includes(WP_ANTIGO)) { console.error("frase antiga do work permit nao encontrada"); process.exit(1); }
  ci = ci.replace(WP_ANTIGO, WP_NOVO);

  let ex = exAntes;
  for (const [de, para] of EX_TROCAS) {
    if (!ex.includes(de)) { console.error(`trecho do exemplo nao encontrado: ${de.slice(0, 60)}`); process.exit(1); }
    ex = ex.replace(de, para);
  }

  console.log(`custom_instructions : ${ciAntes.length} -> ${ci.length} chars (teto 8000)`);
  console.log(`conversation_examples: ${exAntes.length} -> ${ex.length} chars (teto 8000)`);
  // Teto do zod (F31): acima disso o painel recusa o PUT e o agente fica ineditavel pela UI.
  if (ci.length > 8000 || ex.length > 8000) { console.error("estoura o teto de 8000"); process.exit(1); }
  if (DRY) { console.log("(dry) nada gravado"); process.exit(0); }

  // BACKUP antes de escrever. E o caminho de desfazer.
  mkdirSync(DIR_BACKUP, { recursive: true });
  const carimbo = new Date().toISOString().replace(/[:.]/g, "-");
  const arq = resolve(DIR_BACKUP, `agente-17860a86-prompt-backup-${carimbo}.json`);
  writeFileSync(arq, JSON.stringify({
    agent_id: AGENT_ID, config_id: cfg.id, captured_at: new Date().toISOString(),
    config_updated_at: cfg.updated_at, motivo: "ticket #320, despacho d-a304d7",
    custom_instructions: ciAntes, conversation_examples: exAntes, personality: cfg.personality,
  }, null, 2));
  console.log(`backup: ${arq}`);

  const { error: e2 } = await sb.from("agent_configs").update({
    custom_instructions: ci, conversation_examples: ex, updated_at: new Date().toISOString(),
  }).eq("agent_id", AGENT_ID);
  if (e2) { console.error("update falhou:", e2.message); process.exit(1); }

  const { data: v } = await sb.from("agent_configs").select("custom_instructions, conversation_examples").eq("agent_id", AGENT_ID).single();
  const { data: ag } = await sb.from("agents").select("status").eq("id", AGENT_ID).single();
  const ok = v?.custom_instructions === ci && v?.conversation_examples === ex;
  console.log(`${ok ? "OK" : "DIVERGENTE"}: gravado e relido. Status do agente: ${ag?.status} (nao tocado)`);
  console.log(`desfazer: npx tsx scripts/apply-bianca-abertura-v2.ts --revert=_dados_clientes/five-rings/${arq.split("/").pop()}`);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error("ERR:", e?.message || e); process.exit(1); });
