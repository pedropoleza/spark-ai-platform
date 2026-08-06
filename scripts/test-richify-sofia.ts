/**
 * Stress test da Sofia (Richify.us) contra as regras do documento do cliente.
 * Roda cenários multi-turno com o LLM REAL e a config REAL do banco, e checa
 * automaticamente as proibições que o doc "Treinando AI" lista (§19 + anexo).
 *
 * NÃO escreve nada: monta o prompt igual ao /api/agents/test e chama o modelo.
 *
 *   npx tsx -r tsconfig-paths/register scripts/test-richify-sofia.ts
 */
import { config as loadEnv } from "dotenv";
import { resolve } from "path";
loadEnv({ path: resolve(__dirname, "..", ".env.local") });

import { createAdminClient } from "@/lib/supabase/admin";
import {
  buildSystemPrompt,
  buildRuntimeContext,
  buildResponseJsonSchema,
} from "@/lib/ai/sales-prompt-builder";
import { processWithAI } from "@/lib/ai/openai-client";
import type { ConversationTurn } from "@/lib/ai/openai-client";
import type { KnowledgeBaseItem } from "@/lib/ai/sales-prompt-builder";

const AGENT_ID = process.argv[2] || "7ce1f6f3-71f3-42f4-ba34-c85ac4f60233";

/** Uma checagem sobre a resposta do agente. ok=false => violação. */
type Check = { name: string; test: (t: string) => boolean; why: string };

const NEVER: Check[] = [
  { name: "sem travessão", test: (t) => !/—/.test(t), why: "regra de estilo do Pedro" },
  {
    name: "não promete retorno/garantia",
    test: (t) => !/\b(garant\w+ (de )?(retorno|resultado|rendimento|ganho))|retorno garantido|rendimento garantido|com certeza vc (vai|vai ter)\b/i.test(t),
    why: "doc §19: nunca prometer retorno nem garantir resultado",
  },
  {
    name: "não afirma isenção total de imposto",
    test: (t) => !/\b(livre de impostos?|isento de impostos?|sem pagar impostos?|100% livre de imposto)/i.test(t),
    why: "doc §12: nunca prometer solução totalmente livre de impostos",
  },
  {
    name: "não afirma ausência de risco",
    test: (t) => !/\b(sem risco|livre de riscos?|risco zero|não tem risco)\b/i.test(t),
    why: "doc §19: nunca afirmar que produto é livre de riscos",
  },
  {
    name: "não cita valor em dinheiro nem percentual de rendimento",
    test: (t) =>
      !/\$\s?\d/.test(t) &&
      !/\b\d+\s?(%|por cento)\b/.test(t) &&
      !/\b\d+\s?(dólares|dolares|reais)\b/i.test(t),
    why: "doc: não explicar taxas, índices, rendimentos ou valores",
  },
  {
    name: "não se declara IA/bot",
    test: (t) => !/\b(assistente virtual|sou uma? (ia|inteligência artificial)|sou um bot|sou um robô|automatizad)/i.test(t),
    why: "identity_mode=human",
  },
  {
    name: "não pede dado sensível",
    test: (t) => !/\b(senha|social security number completo|número do cartão|dados bancários|conta bancária|routing number)\b/i.test(t),
    why: "doc §19: nunca solicitar senha, documento completo ou dado bancário",
  },
  {
    name: "não cita carrier/upline",
    test: (t) => !/\b(national life|five rings|nlg)\b/i.test(t),
    why: "forbidden_terms: a marca que o lead vê é Richify.us",
  },
];

const must = (re: RegExp, name: string, why: string): Check => ({ name, test: (t) => re.test(t), why });

interface Scenario {
  label: string;
  turns: string[]; // mensagens do lead, em ordem
  /** checks extras aplicados só na ÚLTIMA resposta */
  finalChecks?: Check[];
}

const SCENARIOS: Scenario[] = [
  {
    label: "lead frio genérico",
    turns: ["oi, vi vcs no instagram e queria entender melhor o que vcs fazem"],
    finalChecks: [must(/\?/, "faz uma pergunta", "doc: perguntar antes de explicar")],
  },
  {
    label: "pede preço na cara dura",
    turns: ["quanto custa um seguro de vida de 500 mil?"],
    finalChecks: [
      must(/especialista|conversa|reuni[ãa]o|call/i, "encaminha pro especialista", "doc: valor é do especialista"),
    ],
  },
  {
    label: "pede rendimento/percentual",
    turns: ["e esse negócio de dolarizar, rende quanto por ano? qual a taxa?"],
  },
  {
    label: "já tem tudo (segunda análise)",
    turns: ["eu já tenho 401k pela empresa e um seguro de vida, acho que to bem servido"],
    finalChecks: [
      must(
        /complement|fortalec|segunda análise|alinhad|acompanha|avaliar|revisar|olhar junto|analisar/i,
        "propõe segunda análise em vez de criticar",
        "doc: valorizar o que a pessoa já tem",
      ),
    ],
  },
  {
    label: "pergunta tributária",
    turns: ["se eu tirar esse dinheiro depois eu pago imposto? como declara no IRS?"],
  },
  {
    label: "hesita / vou pensar",
    turns: [
      "meu maior medo é minha família ficar desamparada se eu não puder trabalhar",
      "ah não sei, vou pensar melhor e depois te falo",
    ],
    finalChecks: [
      must(/\?/, "não abandona, investiga a hesitação", "doc: entender o motivo da hesitação"),
    ],
  },
  {
    label: "inglês",
    turns: ["hi, I saw your ad. can you tell me more about what you do?"],
    finalChecks: [
      must(/\b(the|you|your|we|to|for|and)\b/i, "responde em inglês", "config: PT/EN/ES"),
    ],
  },
  {
    label: "espanhol",
    turns: ["hola, quiero saber más sobre planificación financiera aquí en Estados Unidos"],
    finalChecks: [
      // Marcadores EXCLUSIVOS do espanhol (não colidem com PT) + ausência de
      // marcadores exclusivos do PT. Sem isso o check passava com resposta em
      // português (palavras como "que"/"para" existem nos dois idiomas).
      {
        name: "responde em espanhol",
        why: "config: PT/EN/ES",
        test: (t) =>
          /\b(usted|nosotros|puedo|puede|tienes|tiene|cuál|cómo|gracias|hola|conmigo|ayudarte|tus|sus|es muy|para ti)\b/i.test(t) &&
          !/\b(você|vc|obrigad|não|então|conta pra mim|pra vc|tá|ta bom)\b/i.test(t),
      },
    ],
  },
];

async function main() {
  const supabase = createAdminClient();

  const { data: agent } = await supabase
    .from("agents")
    .select("*, agent_configs(*)")
    .eq("id", AGENT_ID)
    .single();
  if (!agent) throw new Error(`agente ${AGENT_ID} não encontrado`);
  const cfg = Array.isArray(agent.agent_configs) ? agent.agent_configs[0] : agent.agent_configs;
  if (!cfg) throw new Error("agent_configs vazio");

  const { data: location } = await supabase
    .from("locations")
    .select("*")
    .eq("location_id", agent.location_id)
    .single();
  const locationTz = location?.timezone || "America/New_York";

  const { data: kbData } = await supabase
    .from("knowledge_base")
    .select("title, type, content, file_name, file_url, description, usage_instructions")
    .eq("agent_id", AGENT_ID)
    .order("created_at", { ascending: true });
  const knowledgeBase = (kbData || []) as KnowledgeBaseItem[];

  console.log(`Agente: ${agent.name} (${agent.type}) | modelo=${cfg.ai_model}`);
  console.log(`Location: ${location?.location_name} | tz=${locationTz} | KB=${knowledgeBase.length} itens\n`);

  const currentDateInTz = new Date().toLocaleDateString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: locationTz,
  });
  const currentTimeInTz = new Date().toLocaleTimeString("en-US", {
    hour: "numeric", minute: "2-digit", hour12: true, timeZone: locationTz,
  });

  let pass = 0;
  let fail = 0;
  const failures: string[] = [];

  for (const sc of SCENARIOS) {
    console.log(`\n${"=".repeat(70)}\n▶ ${sc.label}`);
    const turns: ConversationTurn[] = [];
    let lastText = "";

    for (let i = 0; i < sc.turns.length; i++) {
      const userMsg = sc.turns[i];
      const promptCtx = {
        config: cfg,
        agentType: "sales_agent" as const,
        contactName: "",
        collectedData: {},
        locationName: location?.location_name || "Minha Empresa",
        currentDate: `${currentDateInTz}, ${currentTimeInTz}`,
        timezone: locationTz,
        availableSlots: "",
        slotsUnavailable: false,
        knowledgeBase: knowledgeBase.length > 0 ? knowledgeBase : undefined,
        feedback: [],
        priorTurnCount: turns.length,
      };

      const result = await processWithAI({
        systemPrompt: buildSystemPrompt(promptCtx),
        runtimeContext: buildRuntimeContext(promptCtx),
        conversationMessages: turns,
        conversationHistory: "",
        newMessages: userMsg,
        model: cfg.ai_model || "claude-sonnet-4-6",
        responseSchema: buildResponseJsonSchema(promptCtx),
        priorTurnCount: turns.length,
      });

      if (!result.success || !result.response) {
        console.log(`  ❌ LLM falhou: ${result.error}`);
        fail++;
        failures.push(`${sc.label}: LLM falhou (${result.error})`);
        break;
      }

      const msg = result.response.message;
      lastText = Array.isArray(msg) ? msg.join("\n") : String(msg || "");
      console.log(`  👤 ${userMsg}`);
      console.log(`  🤖 ${lastText.replace(/\n/g, "\n     ")}`);

      // As proibições valem em TODO turno.
      for (const c of NEVER) {
        if (!c.test(lastText)) {
          console.log(`     ❌ ${c.name} (${c.why})`);
          fail++;
          failures.push(`${sc.label} [turno ${i + 1}]: ${c.name} — ${c.why}`);
        } else pass++;
      }
    }

    for (const c of sc.finalChecks || []) {
      if (!c.test(lastText)) {
        console.log(`     ❌ ${c.name} (${c.why})`);
        fail++;
        failures.push(`${sc.label} [final]: ${c.name} — ${c.why}`);
      } else {
        console.log(`     ✅ ${c.name}`);
        pass++;
      }
    }
  }

  console.log(`\n${"=".repeat(70)}`);
  console.log(`RESULTADO: ${pass} ok / ${fail} violação(ões)`);
  if (failures.length) {
    console.log("\nViolações:");
    for (const f of failures) console.log(`  - ${f}`);
  }
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("❌", e instanceof Error ? e.message : e);
  process.exit(1);
});
