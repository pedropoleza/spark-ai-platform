/**
 * Benchmark de modelos (Pedro 2026-06-24): qualidade × custo × latência por caso de
 * uso real do SparkBot, OpenAI × Anthropic. Fundamenta os 3 tiers + roteamento.
 *
 * Uso: npx tsx -r tsconfig-paths/register scripts/bench-models-cost.ts
 *   (precisa ANTHROPIC_API_KEY + OPENAI_API_KEY no .env.local)
 */
import { config } from "dotenv";
import { resolve } from "path";
import { existsSync } from "fs";
config({ path: resolve(__dirname, "..", ".env.local") });
// As chaves de prod (ANTHROPIC + gpt-4.1 válido) ficam só na Vercel. Pra rodar o
// benchmark localmente, puxar com `vercel env pull /tmp/spark-bench.env --environment=production`
// e deixar o dotenv (que parseia o formato KEY="value" certo) sobrepor o .env.local.
if (existsSync("/tmp/spark-bench.env")) config({ path: "/tmp/spark-bench.env", override: true });

import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// $/1M [input, output]
const PRICE: Record<string, [number, number]> = {
  "claude-haiku-4-5": [1, 5],
  "claude-sonnet-4-6": [3, 15],
  "claude-opus-4-8": [5, 25],
  "gpt-4.1": [2, 8],
  "gpt-4.1-mini": [0.4, 1.6],
  "gpt-4.1-nano": [0.1, 0.4],
};
const ANTHRO = new Set(["claude-haiku-4-5", "claude-sonnet-4-6", "claude-opus-4-8"]);

// System prompt representativo (compacto) — o foco é comparar MODELO, não tamanho.
const SYS =
  "Você é o SparkBot, assistente de WhatsApp que opera o CRM 'Spark Leads' pra corretores de seguro BR nos EUA. " +
  "Tom de colega, PT-BR, conciso, sem markdown. Você tem tools: search_contacts, create_note, create_task, " +
  "create_appointment, list_calendars, get_free_slots, list_opportunities, query_carrier_knowledge, schedule_message_to_contact. " +
  "Regra crítica: NUNCA afirme que fez uma ação sem ter chamado a tool. Quando precisar de tool, descreva qual(is) chamaria e com quais argumentos, depois a resposta ao rep.";

interface Task { id: string; tier: string; user: string; rubric: string }
const TASKS: Task[] = [
  { id: "confirma", tier: "fácil", user: "Confirmar ✅ — (resposta à pergunta: 'Marcar reunião com João ter 18h no Client Appointment, com você. Confirma?')",
    rubric: "Deve só executar/confirmar curto e natural (ex: 'Marcado! ✅ Terça 18h com o João.'), SEM oferecer follow-up à toa, SEM re-perguntar." },
  { id: "nota-task", tier: "fácil", user: "🎤 'Anota no contato da Roseli que ela ligou pra saber do seguro, eu liguei e ela pediu pra ligar depois das 5. Cria uma task pra eu retornar amanhã 3 da tarde.'",
    rubric: "Deve chamar search_contacts(Roseli), create_note (com o conteúdo), create_task (amanhã 15h). Não pode inventar contact_id. Resposta curta confirmando as 2 ações." },
  { id: "agendar", tier: "médio", user: "agenda com o Vitor Albuquerque terça 18h no Client Appointment",
    rubric: "Deve resolver contato (search_contacts), calendário (list_calendars), checar slot (get_free_slots) e confirmar UMA vez com dia/data/hora. Não confirmar antes de resolver." },
  { id: "funil", tier: "médio", user: "quantas oportunidades abertas eu tenho e quais as 3 maiores?",
    rubric: "Deve usar list_opportunities/pipelines e responder com número + top 3 por valor, conciso, sem dump cru nem jargão técnico." },
  { id: "carrier", tier: "difícil", user: "🎤 'Minha cliente tem um term de 20 anos feito faz 1 ano, aprovada Elite. Ela quer um term de 30 agora. Dá pra trocar mantendo a classe Elite ou é processo novo?'",
    rubric: "Conhecimento de produto (NLG): explicar que term 20→30 NÃO é conversão, é apólice nova com novo underwriting (pode perder Elite), mencionar issue age. Honesto, prático, em 1ª pessoa pra ela poder repassar." },
  { id: "orquestra", tier: "difícil", user: "monta um fluxo de no-show de 8 mensagens pra Eliz Cruz começando hoje 19h, com vídeo da Natália no dia 2 e link da agenda nos primeiros dias",
    rubric: "Deve PLANEJAR a sequência (8 msgs com dias/horários), resolver o contato, e confirmar o plano ANTES de agendar (não afirmar 'agendado' sem agendar). Estrutura clara dos passos." },
];

async function callAnthropic(model: string, user: string) {
  const t0 = Date.now();
  const r = await anthropic.messages.create({ model, max_tokens: 1024, system: SYS, messages: [{ role: "user", content: user }] });
  const ms = Date.now() - t0;
  const text = r.content.filter((b) => b.type === "text").map((b: { text?: string }) => b.text || "").join("");
  return { text, ms, inTok: r.usage.input_tokens, outTok: r.usage.output_tokens };
}
async function callOpenAI(model: string, user: string) {
  const t0 = Date.now();
  const r = await openai.chat.completions.create({ model, max_tokens: 1024, messages: [{ role: "system", content: SYS }, { role: "user", content: user }] });
  const ms = Date.now() - t0;
  return { text: r.choices[0]?.message?.content || "", ms, inTok: r.usage?.prompt_tokens || 0, outTok: r.usage?.completion_tokens || 0 };
}

async function judge(task: Task, model: string, answer: string): Promise<number> {
  const prompt = `Avalie de 1 a 5 a resposta de um assistente a um corretor. Caso: "${task.user}"\nCRITERIO: ${task.rubric}\nRESPOSTA DO MODELO (${model}):\n${answer}\n\nDê SÓ um número 1-5 (5=excelente, atende o critério com naturalidade; 1=ruim/errado/alucinado). Responda só o dígito.`;
  const r = await anthropic.messages.create({ model: "claude-sonnet-4-6", max_tokens: 5, messages: [{ role: "user", content: prompt }] });
  const txt = r.content.filter((b) => b.type === "text").map((b: { text?: string }) => b.text || "").join("");
  const n = parseInt((txt.match(/[1-5]/) || ["0"])[0], 10);
  return n || 0;
}

async function main() {
  const models = Object.keys(PRICE);
  console.log("# Benchmark modelos — qualidade × custo × latência (SparkBot)\n");
  const agg: Record<string, { q: number; cost: number; ms: number; n: number }> = {};
  for (const t of TASKS) {
    console.log(`\n## [${t.tier}] ${t.id}`);
    console.log(`| modelo | qual(1-5) | in | out | custo($) | ms |`);
    console.log(`|---|---|---|---|---|---|`);
    for (const m of models) {
      try {
        const res = ANTHRO.has(m) ? await callAnthropic(m, t.user) : await callOpenAI(m, t.user);
        const [pi, po] = PRICE[m];
        const cost = (res.inTok * pi + res.outTok * po) / 1e6;
        const q = await judge(t, m, res.text);
        console.log(`| ${m} | ${q} | ${res.inTok} | ${res.outTok} | ${cost.toFixed(5)} | ${res.ms} |`);
        agg[m] = agg[m] || { q: 0, cost: 0, ms: 0, n: 0 };
        agg[m].q += q; agg[m].cost += cost; agg[m].ms += res.ms; agg[m].n++;
      } catch (e) {
        console.log(`| ${m} | ERRO | - | - | - | ${e instanceof Error ? e.message.slice(0, 40) : e} |`);
      }
    }
  }
  console.log("\n## AGREGADO (média por modelo)");
  console.log(`| modelo | qual média | custo total 6 tarefas | ms média |`);
  console.log(`|---|---|---|---|`);
  for (const m of models) {
    const a = agg[m]; if (!a || !a.n) continue;
    console.log(`| ${m} | ${(a.q / a.n).toFixed(2)} | ${a.cost.toFixed(5)} | ${Math.round(a.ms / a.n)} |`);
  }
}
main().catch((e) => { console.error("ERRO:", e instanceof Error ? e.message : e); process.exit(1); });
