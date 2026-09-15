/**
 * Fabiana Campos (7pXJZ8WUq0GpVh0Qd2Ew) — as 2 configurações que ela pediu (15/09).
 *
 *  1. NOME DAS ASSISTENTES. Hoje os agentes se chamam "Pedro" e "Gian". O nome
 *     vive em TRÊS lugares e mudar só um deixa o prompt se contradizendo:
 *       a) `agents.name`            → rótulo no painel
 *       b) `personality.name`       → vira "Você é X, da equipe da ..." (## IDENTIDADE)
 *       c) `custom_instructions`    → "Você é **Pedro**, assistente virtual..."
 *     (c) é a diretriz principal do prompt: trocar só (a) não muda NADA no que o
 *     bot fala. Este script troca os três de uma vez.
 *
 *  2. DESCLASSIFICAR LIVING TRUST. `deactivation_rules` só entende tag e campo —
 *     não existe "o lead disse X". O caminho determinístico (H73: toggle que o
 *     cliente vê precisa de gate atrás, não só frase no prompt) é:
 *       prompt detecta o pedido → grava `servico_nao_atendido=living_trust`
 *       → automação `on_data_field_set` → add_tag + pause_ai.
 *     A ordem do processor garante que a mensagem honesta SAI (passo 8) antes do
 *     pause_ai (passo 11a) — o lead não leva silêncio.
 *
 * Dry-run por padrão. Só escreve com --apply.
 *   npx tsx scripts/fabiana-2-configs.ts
 *   npx tsx scripts/fabiana-2-configs.ts --apply
 *   npx tsx scripts/fabiana-2-configs.ts --trocar-nomes --apply   # Raíssa↔Nayane
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });
import { createAdminClient } from "../src/lib/supabase/admin";
import type { AutomationRule, DataField } from "../src/types/agent";

const APPLY = process.argv.includes("--apply");
const TROCAR = process.argv.includes("--trocar-nomes");

const RECRUTAMENTO = "37bfb23b-0bbf-47f1-bcac-a0eb92aecf98"; // hoje "Pedro" — carreira
const PRODUTOS = "00c7201f-1618-49d5-b79e-c06aed0cd566";     // hoje "Gian"  — benefício em vida / IUL

// Mapa padrão: Nayane nos PRODUTOS (5 das 8 menções reais de leads a "Nayane"
// estão nesse agente), Raíssa no recrutamento. --trocar-nomes inverte.
const NOME_RECRUTAMENTO = TROCAR ? "Nayane" : "Raíssa";
const NOME_PRODUTOS = TROCAR ? "Raíssa" : "Nayane";

const CAMPO = "servico_nao_atendido";
const TAG = "nao-atendemos-living-trust";

const CAMPO_DEF: DataField = {
  key: CAMPO,
  type: "text",
  // O label vai CRU pro prompt (buildDataFieldsTemplateSection). Por isso ele
  // mesmo carrega a ordem de não perguntar — senão o bot trata como pergunta.
  label: "USO INTERNO - nunca perguntar ao lead. Preencher com living_trust apenas se o lead pedir Living Trust",
  required: false,
} as DataField;

function blocoLivingTrust(nome: string): string {
  return `

---

# SERVIÇO QUE NÃO OFERECEMOS — LIVING TRUST

A Fabiana **não** trabalha com **Living Trust** (também chamado de trust, revocable
trust, irrevocable trust, testamento, inventário, partilha de bens, espólio,
herança ou "will"). Isso é planejamento sucessório, área de advogado — não é o
que a Fabiana faz.

Se ficar claro que é isso que o lead procura:

1. **NÃO agende reunião** e **NÃO diga que a Fabiana explica na reunião.** Empurrar
   pro agendamento faz a pessoa ocupar um horário à toa e descobrir na hora.
2. Responda com honestidade, no seu tom normal, em 1 ou 2 mensagens curtas. Ex:
   "Sobre Living Trust a gente não trabalha, viu? Isso é com advogado de
   planejamento sucessório 🙏"
   "O que a Fabiana faz é proteção financeira com benefício em vida e
   aposentadoria/renda vitalícia em dólar. Se algum desses te interessa, me fala
   que eu te explico!"
3. Salve em collected_data o campo "${CAMPO}" com o valor EXATO: living_trust

Se depois disso o lead disser que também quer benefício em vida, IUL ou
aposentadoria, **siga o atendimento normalmente** — quem foi desclassificado é o
assunto Living Trust, não a pessoa.

Você é ${nome} e NUNCA pergunta sobre o campo "${CAMPO}". Ele só é preenchido
quando VOCÊ identificar o pedido sozinha.`;
}

function regraLivingTrust(): AutomationRule {
  return {
    id: "auto-living-trust",
    trigger: { kind: "on_data_field_set", field_key: CAMPO, operator: "contains", value: "living_trust" },
    actions: [{ type: "add_tag", tag: TAG }, { type: "pause_ai", pause_minutes: 0 }],
  } as AutomationRule;
}

async function main() {
  const sb = createAdminClient();
  console.log(APPLY ? "MODO: APLICANDO\n" : "MODO: dry-run (use --apply pra gravar)\n");

  for (const [agentId, nomeNovo, rotulo] of [
    [RECRUTAMENTO, NOME_RECRUTAMENTO, "recrutamento/carreira"],
    [PRODUTOS, NOME_PRODUTOS, "produtos (benefício em vida / IUL)"],
  ] as const) {
    const { data: ag } = await sb.from("agents").select("name").eq("id", agentId).single();
    const { data: cfg } = await sb.from("agent_configs").select("*").eq("agent_id", agentId).single();
    if (!ag || !cfg) { console.log(`!! agente ${agentId} não encontrado`); continue; }

    const nomeAntigo = String(ag.name);
    console.log(`${"=".repeat(68)}\n${rotulo}\n  ${nomeAntigo}  →  ${nomeNovo}\n${"=".repeat(68)}`);

    // --- 1. nome nas 3 camadas ---
    const pers = { ...(cfg.personality as Record<string, unknown> ?? {}) };
    const persAntes = String(pers.name ?? "");
    pers.name = nomeNovo;

    let ci = String(cfg.custom_instructions ?? "");
    const ocorrencias = (ci.match(new RegExp(nomeAntigo, "g")) || []).length;
    ci = ci.split(nomeAntigo).join(nomeNovo);
    console.log(`  personality.name : "${persAntes}" → "${nomeNovo}"`);
    console.log(`  custom_instructions: ${ocorrencias} ocorrência(s) de "${nomeAntigo}" trocadas`);

    // --- 2. campo + bloco + automação do Living Trust ---
    const campos = Array.isArray(cfg.data_fields) ? [...(cfg.data_fields as DataField[])] : [];
    const jaTemCampo = campos.some((f) => f.key === CAMPO);
    if (!jaTemCampo) campos.push(CAMPO_DEF);
    console.log(`  data_fields      : ${jaTemCampo ? "campo já existia" : `+ "${CAMPO}"`} (total ${campos.length})`);

    if (!ci.includes("SERVIÇO QUE NÃO OFERECEMOS")) ci += blocoLivingTrust(nomeNovo);
    console.log(`  custom_instructions: ${ci.length} chars (cap do prompt: 16000)`);
    if (ci.length > 16000) console.log("  ⚠️  ESTOUROU O CAP — o prompt vai truncar!");

    const autos = (Array.isArray(cfg.automations) ? [...(cfg.automations as AutomationRule[])] : [])
      // limpa a regra quebrada que existia: add_tag com tag vazia = no-op
      .filter((r) => !(r.actions?.length === 1 && r.actions[0]?.type === "add_tag" && !r.actions[0]?.tag))
      .filter((r) => r.id !== "auto-living-trust");
    autos.push(regraLivingTrust());
    console.log(`  automations      : ${autos.length} regra(s), incluindo add_tag "${TAG}" + pause_ai`);

    if (!APPLY) { console.log(); continue; }

    const { error: e1 } = await sb.from("agents").update({ name: nomeNovo }).eq("id", agentId);
    if (e1) throw new Error(`agents.name: ${e1.message}`);
    const { error: e2 } = await sb.from("agent_configs")
      .update({ personality: pers, custom_instructions: ci, data_fields: campos, automations: autos })
      .eq("agent_id", agentId);
    if (e2) throw new Error(`agent_configs: ${e2.message}`);
    console.log("  ✅ gravado\n");
  }

  if (APPLY) {
    console.log("CONFERÊNCIA:");
    for (const id of [RECRUTAMENTO, PRODUTOS]) {
      const { data: a } = await sb.from("agents").select("name,status").eq("id", id).single();
      const { data: c } = await sb.from("agent_configs").select("personality,data_fields,automations").eq("agent_id", id).single();
      const p = c?.personality as { name?: string } | null;
      const campos = (c?.data_fields as DataField[] ?? []).map((f) => f.key);
      console.log(`  ${String(a?.name).padEnd(8)} [${a?.status}] persona=${p?.name} campo=${campos.includes(CAMPO) ? "ok" : "FALTA"} automacoes=${(c?.automations as unknown[] ?? []).length}`);
    }
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error("FATAL:", e instanceof Error ? e.message : e); process.exit(1); });
