/**
 * Validação REAL da "entrada pela automação" na conta da Márcia (H90).
 *
 * Três provas, com config de PRODUÇÃO:
 *  1. Targeting: só a tag liga o agente (a frase do anúncio não liga mais).
 *  2. A resposta do lead à automação NÃO auto-pausa a IA (o último outbound é
 *     do workflow, com userId — o F52 tem que ler como automação).
 *  3. Modelo real, prompt real, histórico igual ao de produção (clique do
 *     anúncio → saudação do workflow → áudio → bloco dos 4 dados) e a resposta
 *     do lead: a IA NÃO se apresenta, NÃO repete o bloco, NÃO promete áudio, e
 *     continua de onde a automação parou.
 *
 * Rodar: ANTHROPIC_API_KEY=... npx tsx scripts/validate-marcia-entrada.ts
 */
import * as dotenv from "dotenv"; dotenv.config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { buildSystemPrompt, buildRuntimeContext, buildResponseJsonSchema } from "@/lib/ai/sales-prompt-builder";
import { processWithAI } from "@/lib/ai/openai-client";
import { evaluateTargetingSet } from "@/lib/queue/targeting";
import { classifyLastOutbound } from "@/lib/queue/human-takeover";
import type { TargetingRuleSet } from "@/types/agent";

const AGENT = "7c0a72b7-e37c-463d-be56-73b7822a3037";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
let pass = 0, fail = 0;
const ok = (nome: string, cond: boolean, extra = "") => { if (cond) { pass++; console.log(`  ✅ ${nome}`); } else { fail++; console.log(`  ❌ ${nome} ${extra}`); } };

// O que a automação manda (textos reais da conta, conversa da Angela 03/09)
const CLIQUE = "📢 Veio de anúncio (instagram): \"Márcia Oliveira\" https://www.instagram.com/p/Da5ygCPMXFx/ Quero entender como funciona o seguro com benefício em vida.";
const WF_SAUDACAO = "Oi, tudo bem? 😊 Nós somos a Márcia e a Roberta, especialistas em seguro de vida com benefícios em vida, licenciadas nos EUA. Esse seguro protege sua família e, em situações elegíveis, permite acesso a parte do valor ainda em vida.";
const WF_AUDIO = "🎤 Mensagem de voz (0:47)";
const WF_DADOS = "💰 O valor muda de pessoa pra pessoa... Depende da idade, se é homem ou mulher, se fuma e o valor da proteção. Passa pra gente esses dados abaixo: • Nome e sobrenome • Data de nascimento (mês primeiro) • Estado onde mora • É fumante? (sim/não) Se for casada(o) manda os dados do seu cônjuge também. Vamos deixar sua cotação pronta, e depois te chamamos aqui pra apresentar as opções, ok? 🤗";

const SE_APRESENTA = /somos a m[áa]rcia|que bom que voc[êe] chegou|n[óo]s somos|especialistas em seguro de vida/i;
const PROMETE_AUDIO = /audiozinho|te mandando um [áa]udio|vou te mandar um [áa]udio/i;
// "Bloco" = a LISTA (tópicos ou uma linha por dado). Pedir os 4 numa frase só,
// sem tópicos, é o que o prompt manda quando o lead não mandou nada.
const BLOCO_4 = (t: string) => (t.match(/•/g) ?? []).length >= 3 || (t.split("\n").length >= 4 && /nome/i.test(t) && /nascimento/i.test(t) && /estado/i.test(t) && /fum/i.test(t));

async function main() {
  const { data } = await sb.from("agent_configs").select("*").eq("agent_id", AGENT).single();
  const cfg = data as Record<string, unknown>;

  console.log("\n1) Targeting: só a tag liga o agente");
  const rules = cfg.targeting_rules as TargetingRuleSet;
  const comTag = { tags: ["ctwa-lead", "anuncio", "ai qualification active"], customFields: [] };
  const semTag = { tags: ["ctwa-lead", "anuncio"], customFields: [] };
  ok("contato COM a tag → atende", evaluateTargetingSet(rules, comTag as never, [], { messageText: "oi" }) === true);
  ok("contato SEM a tag, mesmo com a frase do anúncio → NÃO atende", evaluateTargetingSet(rules, semTag as never, [], { messageText: CLIQUE }) === false);
  ok("tag com caixa diferente ('AI Qualification Active') → atende", evaluateTargetingSet(rules, { tags: ["AI Qualification Active"], customFields: [] } as never, [], { messageText: "oi" }) === true);

  console.log("\n2) Resposta do lead à automação não auto-pausa a IA");
  const ultimoOutboundDoWorkflow = { id: "wf1", body: WF_DADOS, userId: "HlBpHx6qe7vpiFc2acjr", source: "workflow", dateAdded: "2026-09-03T11:27:21Z" };
  ok("último outbound = workflow (com userId) → NÃO é humano", classifyLastOutbound({ lastOutbound: ultimoOutboundDoWorkflow, aiTexts: [] }).isHuman === false);
  ok("(controle) texto de humano de verdade → é humano", classifyLastOutbound({ lastOutbound: { id: "h1", body: "oi, aqui é a Roberta, posso te ligar?", userId: "x", source: "app" }, aiTexts: ["outra coisa"] }).isHuman === true);

  console.log("\n3) Modelo real: a IA continua de onde a automação parou");
  const historico = [
    { role: "user" as const, content: CLIQUE },
    { role: "assistant" as const, content: WF_SAUDACAO },
    { role: "assistant" as const, content: WF_AUDIO },
    { role: "assistant" as const, content: WF_DADOS },
  ];
  const cenarios: Array<{ nome: string; lead: string; checa: (t: string) => { ok: boolean; porque: string } }> = [
    { nome: "A) lead manda os 4 dados", lead: "Maria Silva\n02/23/1967\nNewark NJ\nnão fumante\ncasada",
      checa: (t) => /c[ôo]njuge|marido|esposa|agend|hor[áa]rio|liga[çc][ãa]o/i.test(t) ? { ok: true, porque: "seguiu pro próximo passo" } : { ok: false, porque: "não avançou" } },
    { nome: "B) lead responde só 'oi'", lead: "oi",
      checa: (t) => ({ ok: true, porque: "sem apresentação e sem bloco (checado abaixo)" }) },
    { nome: "C) lead pergunta preço", lead: "quanto custa mais ou menos?",
      checa: (t) => /idade|estado|fumante|cota[çc][ãa]o|especialista|valor/i.test(t) ? { ok: true, porque: "respondeu a pergunta" } : { ok: false, porque: "ignorou a pergunta" } },
    // Data sem ambiguidade de propósito: com "05/10" o prompt manda CONFIRMAR
    // (outubro ou maio?) e isso é o comportamento certo, não o que se testa aqui.
    { nome: "D) lead manda só nome e nascimento", lead: "Ana Souza, 25/10/1980",
      checa: (t) => (/estado/i.test(t) && /fum/i.test(t) && !/nome e sobrenome|nome completo/i.test(t)) ? { ok: true, porque: "cobrou só o que faltou (estado + fumante)" } : { ok: false, porque: "não cobrou só o que faltou" } },
  ];
  for (const c of cenarios) {
    // Igual à produção (queue-processor ~1777): system + runtimeContext + schema
    // estruturado a partir do MESMO promptCtx. Sem o schema, o parser devolve
    // "problema técnico" e o teste mede o harness, não o prompt.
    const promptCtx = {
      config: cfg as never, agentType: "sales_agent", contactName: "Lead", collectedData: {},
      locationName: "Five Star Ricos", currentDate: new Date().toLocaleDateString("pt-BR"), timezone: "America/New_York",
      priorTurnCount: historico.length,
    } as never;
    const systemPrompt = buildSystemPrompt(promptCtx);
    const runtimeContext = buildRuntimeContext(promptCtx);
    const responseSchema = buildResponseJsonSchema(promptCtx);
    const r = await processWithAI({
      systemPrompt, runtimeContext, responseSchema,
      conversationMessages: historico, conversationHistory: "", newMessages: c.lead,
      model: String(cfg.ai_model || "claude-sonnet-4-6"), priorTurnCount: historico.length,
    });
    const raw = r.response?.message; const texto = (Array.isArray(raw) ? raw.join(" ") : String(raw ?? "")).trim();
    const v = c.checa(texto);
    const apresenta = SE_APRESENTA.test(texto), bloco = BLOCO_4(texto), audio = PROMETE_AUDIO.test(texto);
    const tudo = v.ok && !apresenta && !bloco && !audio;
    console.log(`${tudo ? "✅" : "❌"} ${c.nome}`);
    console.log(`   saiu: ${JSON.stringify(texto.slice(0, 200))}`);
    console.log(`   ${v.porque}${apresenta ? " | ❌ SE APRESENTOU" : ""}${bloco ? " | ❌ REPETIU O BLOCO" : ""}${audio ? " | ❌ PROMETEU ÁUDIO" : ""}`);
    tudo ? pass++ : fail++;
  }
  console.log(`\n${pass}/${pass + fail} passaram`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
