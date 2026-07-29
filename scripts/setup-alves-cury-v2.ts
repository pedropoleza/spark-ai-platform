/**
 * Alves Cury v2 (2026-07-29) — correção geral dos agentes Bruna/Bruno + modo teste.
 *
 * Contexto (incidentes 07-23/07-28, prints do Pedro): booking sem escolha do lead,
 * "com família" inventado, troca pra espanhol por um "Hola", thread da campanha
 * errada continuada, rajada de 4 balões. Causa-raiz #1: `system_prompt_override`
 * carregava o prompt CRU do N8n (mustache `{{ $('Webhook')... }}`, tool fantasma
 * "Get Appointment Available Slots") e ENTERRAVA as custom_instructions boas do
 * porte (o override substitui custom_instructions + pula a seção de histórico F37).
 *
 * O que este script faz (default = MODO TESTE):
 *  1. `system_prompt_override = null` → ativa o caminho canônico do builder
 *     (identidade, histórico F37, custom_instructions, regras de slots F24/F48,
 *     turn-state anti-repetição, response format).
 *  2. `custom_instructions` = base do porte + bloco "# REGRAS ANTI-INCIDENTE"
 *     (idioma/Hola, anti-fabricação, campanha desta conversa, 2 tempos do
 *     agendamento, máx 2 balões, pergunta pendente). Idempotente (re-run substitui
 *     o bloco).
 *  3. `conversation_examples` = fluxo ideal + erros reais → forma certa.
 *  4. `ai_model` → claude-sonnet-4-6 (compliance de instrução melhor que 4-5).
 *  5. targeting → TAG DE TESTE (teste-ia-venda / teste-ia-recrut) e status=active:
 *     os agentes viram os "agentes de teste" (mesmo type/config = paridade total;
 *     UNIQUE(location_id,type) impede clone). Lead real NÃO tem a tag → não casa.
 *     A tag também é o trigger reativo (tag_added dispara o opener pro tester).
 *
 *  --restore-prod-targeting: devolve o targeting de produção (frase do anúncio OU
 *  campo AI) mantendo os prompts novos. Rodar APÓS validação com o time.
 *
 * Uso:
 *   npx tsx scripts/setup-alves-cury-v2.ts
 *   npx tsx scripts/setup-alves-cury-v2.ts --restore-prod-targeting
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });
import { createAdminClient } from "../src/lib/supabase/admin";

const LOC = "YuR0LCZomFzrfkDK2ezo";
const BRUNA_ID = "e698f2b4-92bf-4c6a-9429-dc18ab94096b"; // sales_agent
const BRUNO_ID = "a0339877-7096-4384-a2d8-34d9daedb339"; // recruitment_agent
const MODEL = "claude-sonnet-4-6";
const MARKER = "# REGRAS ANTI-INCIDENTE";

// ─── Targeting ───────────────────────────────────────────────────────────────
const TEST_TARGETING = (tag: string) => ({
  version: 2,
  match: "all",
  groups: [{ id: "g-teste", match: "all", rules: [{ id: "t-teste", type: "tag", tag }] }],
});

const PROD_TARGETING_BRUNA = {
  match: "any",
  groups: [
    { id: "g-anuncio-venda", match: "all", rules: [{ id: "ac-sales", type: "message", message_value: "Moro nos EUA e gostaria de mais informações sobre o seguro com beneficio em vida", message_operator: "contains" }] },
    { id: "g-campo-ai", match: "all", rules: [{ id: "ac-cf-venda", type: "custom_field", custom_field_key: "C7LzKTXG3QHJuzfqOi9T", custom_field_value: "Venda" }] },
  ],
  version: 2,
};
const PROD_TARGETING_BRUNO = {
  match: "any",
  groups: [
    { id: "g-anuncio-recrut", match: "all", rules: [{ id: "ac-recruit", type: "message", message_value: "Moro nos EUA e gostaria de mais informações de como me tornar agente financeiro", message_operator: "contains" }] },
    { id: "g-campo-ai", match: "all", rules: [{ id: "ac-cf-recruit", type: "custom_field", custom_field_key: "C7LzKTXG3QHJuzfqOi9T", custom_field_value: "Recruit" }] },
  ],
  version: 2,
};

// ─── Bloco anti-incidente (cada regra nasceu de um erro real dos prints) ─────
function antiIncidentBlock(campanha: string, outraCampanha: string): string {
  return `${MARKER} (2026-07-29 — cada regra nasceu de um erro real em produção; inviolável)

IDIOMA: converse em português. "Hola", "Gracias", "ok" ou palavra solta NÃO significam que o lead fala espanhol (brasileiro também usa). SÓ mude de idioma se o lead escrever uma FRASE INTEIRA em espanhol ou inglês; aí siga 100% no idioma dele, sem misturar, e não volte pro português por conta própria.

FATOS DO LEAD: NUNCA afirme algo que o lead não disse NESTA conversa (família, filhos, casa, negócio...). Os modelos de frase deste prompt são MOLDES: preencha só com o que ele realmente falou. Se ele só disse a profissão, a ponte ecoa SÓ a profissão — sem "com família aqui" inventado.

CAMPANHA DESTA CONVERSA: ${campanha}. O histórico pode conter conversa ANTIGA de outra campanha nossa (${outraCampanha}) — NÃO continue aquele assunto, NÃO misture os dois. Lead confuso ("licença de que?", "não pedi isso"): esclareça em 1 frase qual é o assunto desta conversa e siga nele.

AGENDAMENTO EM 2 TEMPOS (nunca pule): TEMPO 1 = oferecer 2 horários REAIS tirados da seção "HORÁRIOS DISPONÍVEIS" do contexto (se ela estiver ausente, vazia ou indisponível, NÃO cite nenhum horário — peça dia + turno preferido e diga que confirma). TEMPO 2 = SÓ DEPOIS de o lead escolher explicitamente um deles ("terça", "o das 3", "o segundo") é que você inclui a action book_appointment com ESSE horário. PROIBIDO: book_appointment no mesmo turno em que os horários são oferecidos; book_appointment sem escolha explícita; dizer "agendado" sem a action no mesmo turno. Confirmação sempre com dia da semana + data + hora + fuso.

BALÕES: no máximo 2 mensagens por resposta (máx 2 itens no array "message"). Confirmação de agendamento é 1 balão só.

PERGUNTA PENDENTE: se o lead responder com saudação ou outra pergunta sem responder a sua, responda o que ele trouxe e refaça a sua pergunta com PALAVRAS DIFERENTES (nunca idêntica à anterior). Refez 2x sem resposta? Siga o fluxo sem esse dado.`;
}

// ─── Exemplos de conversa (fluxo ideal + erros reais → forma certa) ──────────
function examples(persona: "bruna" | "bruno"): string {
  const fluxo = persona === "bruna"
    ? `# FLUXO IDEAL (agendamento em 2 tempos)
Lead: "Sou motorista de caminhão"
Você (TEMPO 1 — ofereceu, NÃO agendou): "Motorista de caminhão, trabalho pesado esse. Cada caso é diferente, e um de nossos agentes te mostra via Zoom uma opção pro seu perfil em uns 30 min. Deixa eu ver a agenda... Tem quinta às 3 da tarde ou sexta às 7 da noite, qual funciona melhor?" [SEM action]
Lead: "Pode ser quinta"
Você (TEMPO 2 — agora sim): "Fechado! Quinta-feira, 31/07, às 3 da tarde (horário do leste). Vc recebe a confirmação por aqui." [action book_appointment com o slot de quinta 15:00]`
    : `# FLUXO IDEAL (doc → 2 tempos)
Lead: "To começando do zero"
Você: "Tranquilo, muita gente começa do zero. Pra essa trilha só preciso confirmar: vc tem social security e permissão de trabalho aqui?"
Lead: "Tenho sim"
Você (TEMPO 1): "Perfeito. A Taciana te explica o modelo e o passo a passo numa conversa rápida por Zoom. Deixa eu ver a agenda dela... Tem quinta às 2 da tarde ou segunda às 8 da noite, qual encaixa melhor?" [SEM action]
Lead: "Segunda"
Você (TEMPO 2): "Fechado! Segunda-feira, 04/08, às 8 da noite (horário do leste). A confirmação chega por aqui." [action book_appointment com o slot de segunda 20:00]`;

  return `${fluxo}

# ERROS REAIS (aconteceram em produção — NUNCA repita)
ERRADO: lead disse só "sou técnico de IA" → "Técnico de IA com família aqui nos EUA..." (inventou família).
CERTO: "Técnico de IA, boa área. Cada caso é diferente..." (ecoa SÓ o que ele disse).
ERRADO: lead mandou "Hola" (uma palavra) → você trocou toda a conversa pra espanhol.
CERTO: seguir em português; só trocar se vier frase inteira em espanhol.
ERRADO: "Deixa eu ver aqui na agenda..." + action book_appointment no MESMO turno, sem o lead escolher.
CERTO: oferecer os 2 horários e ESPERAR a escolha; a action só vem no turno seguinte.
ERRADO: repetir "Vc já tem licença ou ta começando do zero?" 3x igual.
CERTO: refazer 1x com outras palavras ("me conta, vc já atua com seguros ou seria começo?"), depois seguir sem o dado.`;
}

// ─── Runner ──────────────────────────────────────────────────────────────────
async function main() {
  const restore = process.argv.includes("--restore-prod-targeting");
  const supabase = createAdminClient();

  const AGENTS = [
    { id: BRUNA_ID, nome: "Bruna (vendas)", tag: "teste-ia-venda", prod: PROD_TARGETING_BRUNA, campanha: "SEGURO DE VIDA com benefício em vida / proteção financeira", outra: "recrutamento de agente financeiro, conduzida pelo Bruno", persona: "bruna" as const },
    { id: BRUNO_ID, nome: "Bruno (recrutamento)", tag: "teste-ia-recrut", prod: PROD_TARGETING_BRUNO, campanha: "a oportunidade de VIRAR AGENTE FINANCEIRO", outra: "venda de seguro de vida, conduzida pela Bruna", persona: "bruno" as const },
  ];

  for (const a of AGENTS) {
    const { data: cfg, error: cfgErr } = await supabase
      .from("agent_configs")
      .select("custom_instructions")
      .eq("agent_id", a.id)
      .single();
    if (cfgErr || !cfg) throw new Error(`config de ${a.nome} não encontrada: ${cfgErr?.message}`);

    // Base = custom_instructions atual SEM bloco anti-incidente anterior (idempotente).
    const base = String(cfg.custom_instructions || "").split(MARKER)[0].trimEnd();
    const novo = `${base}\n\n${antiIncidentBlock(a.campanha, a.outra)}`;
    if (novo.length > 8000) throw new Error(`${a.nome}: custom_instructions ficaria com ${novo.length} chars (cap 8000)`);

    const patch: Record<string, unknown> = {
      system_prompt_override: null,
      custom_instructions: novo,
      conversation_examples: examples(a.persona),
      ai_model: MODEL,
      targeting_rules: restore ? a.prod : TEST_TARGETING(a.tag),
    };
    const { error: upErr } = await supabase.from("agent_configs").update(patch).eq("agent_id", a.id);
    if (upErr) throw new Error(`update config ${a.nome}: ${upErr.message}`);

    const { error: agErr } = await supabase.from("agents").update({ status: "active" }).eq("id", a.id);
    if (agErr) throw new Error(`activate ${a.nome}: ${agErr.message}`);

    console.log(`✅ ${a.nome}: override=null · custom=${novo.length}ch · examples=${examples(a.persona).length}ch · model=${MODEL} · targeting=${restore ? "PRODUÇÃO (frase/campo AI)" : `TESTE (tag ${a.tag})`} · status=active`);
  }

  if (restore) {
    console.log("\n🚀 Targeting de PRODUÇÃO restaurado — agentes atendendo leads reais (frase do anúncio OU campo AI).");
  } else {
    console.log(`\n🧪 MODO TESTE ativo. Pro time testar:
 1. Criar/usar um contato de teste no Spark Leads.
 2. Adicionar a tag "teste-ia-venda" (Bruna) OU "teste-ia-recrut" (Bruno) — a tag já dispara o opener.
 3. Conversar normalmente pelo WhatsApp. Leads reais NÃO têm a tag → não são atendidos.
 4. Validou? npx tsx scripts/setup-alves-cury-v2.ts --restore-prod-targeting`);
  }
}
main().catch((e) => { console.error("FATAL:", e instanceof Error ? e.message : e); process.exit(1); });
