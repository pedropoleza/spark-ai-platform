/**
 * Smoke real de agentes via SDK direto (F23, Pedro 2026-05-28).
 *
 * Pedro pediu testes REAIS pra fechar o gap "smoke validation 35/100".
 *
 * Estratégia:
 *   - 4 agents simulados (sales claude, sales gpt, recruitment claude,
 *     sparkbot claude) com configs distintas
 *   - 5 turnos por conversa (cliente realista + saudação + qualificação)
 *   - Chama SDK direto (Anthropic ou OpenAI) com system prompt
 *     construído via buildSystemPrompt do código de prod
 *   - Salva transcripts + análise em _planning/_smoke-2026-05-28/
 *
 * Custo estimado: ~$0.30 (Claude Sonnet 0.05 × 5 × 4 + GPT-4.1-mini)
 *
 * NÃO testa tool calling real (sem GHL/DB) — testa quality de resposta,
 * persona, anti-regressão de prompt build.
 *
 * Rodar: `npx tsx scripts/smoke-real-conversations.ts`
 */
import { config as loadEnv } from "dotenv";
import { writeFileSync, appendFileSync } from "fs";
import path from "path";

// Carrega .env.smoke (env vars de prod) pra ter API keys
loadEnv({ path: ".env.smoke" });

import { buildSystemPrompt } from "../src/lib/ai/sales-prompt-builder";
import type { AgentConfig } from "../src/types/agent";

// ============================================================================
// CONFIGS SAMPLE (espelham agents reais em prod)
// ============================================================================

interface AgentSample {
  id: string;
  name: string;
  type: "sales_agent" | "recruitment_agent" | "account_assistant";
  config: Partial<AgentConfig> & { ai_model: string };
  description: string;
}

const SAMPLES: AgentSample[] = [
  {
    id: "sales-claude-default",
    name: "Sales Sonnet padrão (50/50/50/50)",
    type: "sales_agent",
    description: "Vendedor de seguros de vida, tom neutro, Claude Sonnet 4.6",
    config: {
      personality: { name: "Marina", identity_mode: "human", greeting_style: "", farewell_style: "", language: "pt-BR", persona_description: "" },
      tone_creativity: 50, tone_formality: 50, tone_naturalness: 50, tone_aggressiveness: 50,
      custom_instructions: "Você vende seguros de vida pra famílias brasileiras na Flórida. Qualificar lead: idade, estado civil, filhos, orçamento mensal. Após qualificação, agendar reunião com especialista.",
      conversation_examples: "",
      confirmation_mode: "medium_and_high",
      objective: "qualification_and_booking",
      enabled_channels: ["WhatsApp"],
      data_fields: [
        { key: "idade", type: "text", required: true, label: "Idade" },
        { key: "filhos", type: "text", required: true, label: "Tem filhos?" },
        { key: "orcamento_mensal", type: "text", required: false, label: "Orçamento mensal disponível" },
      ],
      targeting_rules: [],
      follow_up_config: { enabled: true, mode: "ai_auto", intensity: 5, max_attempts: 3, min_delay_minutes: 60, max_delay_minutes: 10080, manual_steps: [] },
      working_hours: { enabled: false, timezone: "America/New_York", mode: "only_during", schedule: {} },
      ai_model: "gpt-4.1-mini",  /* Anthropic API key não setada em prod; usa OpenAI pra todos */
    },
  },
  {
    id: "sales-gpt-aggressive",
    name: "Sales GPT-4.1-mini agressivo (70/35/95/70)",
    type: "sales_agent",
    description: "Tom muito natural, formal-baixo, criativo, agressivo. GPT-4.1-mini.",
    config: {
      personality: { name: "Carlos", identity_mode: "human", greeting_style: "", farewell_style: "", language: "pt-BR", persona_description: "" },
      tone_creativity: 70, tone_formality: 35, tone_naturalness: 95, tone_aggressiveness: 70,
      custom_instructions: "Vende plano de saúde corporativo pra PMEs brasileiras. Foco em fechar reunião RÁPIDO — não perde tempo com lead frio.",
      conversation_examples: "",
      confirmation_mode: "high_only",
      objective: "qualification_and_booking",
      enabled_channels: ["WhatsApp"],
      data_fields: [
        { key: "qtd_funcionarios", type: "text", required: true, label: "Quantos funcionários?" },
        { key: "tem_plano_atual", type: "text", required: true, label: "Já tem plano de saúde?" },
      ],
      targeting_rules: [],
      follow_up_config: { enabled: true, mode: "ai_auto", intensity: 7, max_attempts: 4, min_delay_minutes: 30, max_delay_minutes: 4320, manual_steps: [] },
      working_hours: { enabled: false, timezone: "America/Sao_Paulo", mode: "only_during", schedule: {} },
      ai_model: "gpt-4.1-mini",
    },
  },
  {
    id: "recruitment-claude-friendly",
    name: "Recruitment Sonnet amigável (70/30/80/40)",
    type: "recruitment_agent",
    description: "Recrutador de corretores autônomos. Tom amigável, baixa pressão.",
    config: {
      personality: { name: "Patricia", identity_mode: "human", greeting_style: "", farewell_style: "", language: "pt-BR", persona_description: "" },
      tone_creativity: 70, tone_formality: 30, tone_naturalness: 80, tone_aggressiveness: 40,
      custom_instructions: "Recruta corretores de seguros autônomos pra agência. Qualificar: experiência prévia, disponibilidade, se já tem licença, motivação pra entrar na área.",
      conversation_examples: "",
      confirmation_mode: "medium_and_high",
      objective: "qualification_and_booking",
      enabled_channels: ["WhatsApp"],
      data_fields: [
        { key: "experiencia", type: "text", required: true, label: "Experiência no setor?" },
        { key: "tem_licenca", type: "boolean", required: true, label: "Tem licença?" },
        { key: "disponibilidade", type: "text", required: true, label: "Disponibilidade" },
      ],
      targeting_rules: [],
      follow_up_config: { enabled: true, mode: "ai_auto", intensity: 4, max_attempts: 3, min_delay_minutes: 120, max_delay_minutes: 10080, manual_steps: [] },
      working_hours: { enabled: false, timezone: "America/New_York", mode: "only_during", schedule: {} },
      ai_model: "gpt-4.1-mini",  /* Anthropic API key não setada em prod; usa OpenAI pra todos */
    },
  },
];

// ============================================================================
// CENÁRIOS DE TESTE (mensagens hipotéticas de lead)
// ============================================================================

const SCENARIOS: Record<string, string[]> = {
  "sales-claude-default": [
    "Oi, vi anúncio sobre seguro de vida. Pode me explicar?",
    "Tenho 35 anos, casado, 2 filhos pequenos.",
    "Acho que posso investir uns 200 dólares por mês.",
    "Qual seria o próximo passo?",
    "Pode ser sexta às 14h."
  ],
  "sales-gpt-aggressive": [
    "Oi, recebi seu contato sobre plano de saúde empresarial.",
    "Temos 47 funcionários. Já temos plano da Bradesco mas tá caro.",
    "Quanto vocês conseguem economizar?",
    "Quero saber as condições antes de marcar reunião.",
    "OK, manda info por escrito."
  ],
  "recruitment-claude-friendly": [
    "Oi, vi o anúncio de vagas. Sou interessado.",
    "Não tenho experiência ainda mas tenho vontade.",
    "Posso me dedicar full time. Tenho 28 anos.",
    "Não tenho licença ainda, é difícil tirar?",
    "Pode ser na próxima semana, tarde."
  ],
};

// ============================================================================
// HARNESS
// ============================================================================

const OUTPUT_PATH = path.join(
  process.cwd(),
  "_planning/_smoke-2026-05-28/transcripts.md",
);

function header() {
  return `# Smoke Real de Agentes — ${new Date().toISOString()}

> F23 (Pedro 2026-05-28): smoke validation gap. Roda 3 agents distintos com 5 turnos cada usando system prompt REAL do projeto (buildSystemPrompt).

Custos: ~$0.30 estimado.

---

`;
}

interface AgentResult {
  sample: AgentSample;
  promptLength: number;
  transcript: { role: "user" | "agent"; text: string; latencyMs?: number; tokens?: number; toolsRequested?: string[] }[];
  summary: { totalTurns: number; avgLatencyMs: number; totalTokens: number; errors: string[] };
}

async function runOpenAI(systemPrompt: string, history: { role: string; content: string }[], model: string): Promise<{ text: string; tokens: number }> {
  const { default: OpenAI } = await import("openai");
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const res = await client.chat.completions.create({
    model,
    messages: [{ role: "system", content: systemPrompt }, ...(history as { role: "system" | "user" | "assistant"; content: string }[])],
    temperature: 0.5,
    max_tokens: 600,
  });
  return {
    text: res.choices[0]?.message?.content || "",
    tokens: (res.usage?.prompt_tokens || 0) + (res.usage?.completion_tokens || 0),
  };
}

async function runAnthropic(systemPrompt: string, history: { role: string; content: string }[], model: string): Promise<{ text: string; tokens: number }> {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const mapped = history
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: (m.role === "assistant" ? "assistant" : "user") as "user" | "assistant", content: m.content }));
  const res = await client.messages.create({
    model: model.includes("sonnet-4-6") ? "claude-sonnet-4-6" : model,
    max_tokens: 600,
    system: systemPrompt,
    messages: mapped,
    temperature: 0.5,
  });
  const block = res.content.find((c) => c.type === "text");
  const text = block && "text" in block ? block.text : "";
  return {
    text,
    tokens: (res.usage.input_tokens || 0) + (res.usage.output_tokens || 0),
  };
}

async function runOneAgent(sample: AgentSample): Promise<AgentResult> {
  const result: AgentResult = {
    sample,
    promptLength: 0,
    transcript: [],
    summary: { totalTurns: 0, avgLatencyMs: 0, totalTokens: 0, errors: [] },
  };

  // Build system prompt usando código real de prod
  let systemPrompt: string;
  try {
    systemPrompt = buildSystemPrompt({
      config: sample.config as AgentConfig,
      agentType: sample.type === "account_assistant" ? "custom_agent" : sample.type,
      contactName: "Lead Teste",
      collectedData: {},
      locationName: "Spark Leads (smoke test)",
      currentDate: new Date().toISOString(),
      timezone: "America/New_York",
      priorTurnCount: 0,
      knowledgeBase: [],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    result.promptLength = systemPrompt.length;
  } catch (err) {
    result.summary.errors.push(`buildSystemPrompt: ${err instanceof Error ? err.message : err}`);
    return result;
  }

  const userMessages = SCENARIOS[sample.id] || [];
  const conversationHistory: { role: string; content: string }[] = [];
  const latencies: number[] = [];

  for (const userMsg of userMessages) {
    conversationHistory.push({ role: "user", content: userMsg });
    result.transcript.push({ role: "user", text: userMsg });

    const startedAt = Date.now();
    try {
      const isClaude = sample.config.ai_model?.includes("claude");
      const { text, tokens } = isClaude
        ? await runAnthropic(systemPrompt, conversationHistory, sample.config.ai_model!)
        : await runOpenAI(systemPrompt, conversationHistory, sample.config.ai_model!);
      const latency = Date.now() - startedAt;
      latencies.push(latency);
      result.summary.totalTokens += tokens;
      conversationHistory.push({ role: "assistant", content: text });
      result.transcript.push({ role: "agent", text, latencyMs: latency, tokens });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      result.summary.errors.push(errMsg.slice(0, 200));
      result.transcript.push({ role: "agent", text: `[ERROR] ${errMsg.slice(0, 200)}` });
      break;
    }
  }

  result.summary.totalTurns = userMessages.length;
  result.summary.avgLatencyMs = latencies.length > 0 ? Math.round(latencies.reduce((s, n) => s + n, 0) / latencies.length) : 0;
  return result;
}

function renderResult(r: AgentResult): string {
  const lines: string[] = [];
  lines.push(`## ${r.sample.name}`);
  lines.push(`- **Type:** \`${r.sample.type}\``);
  lines.push(`- **Model:** \`${r.sample.config.ai_model}\``);
  lines.push(`- **Descrição:** ${r.sample.description}`);
  lines.push(`- **System prompt:** ${r.promptLength.toLocaleString()} chars`);
  lines.push(`- **Total tokens:** ${r.summary.totalTokens.toLocaleString()}`);
  lines.push(`- **Latência média:** ${r.summary.avgLatencyMs}ms`);
  if (r.summary.errors.length > 0) {
    lines.push(`- **⚠️ Erros:** ${r.summary.errors.join(" | ")}`);
  }
  lines.push("");
  lines.push("### Transcript");
  for (const turn of r.transcript) {
    if (turn.role === "user") {
      lines.push(`> **Lead:** ${turn.text}`);
    } else {
      lines.push(`**${r.sample.config.personality?.name || "Agente"}** (${turn.latencyMs}ms · ${turn.tokens} tok):`);
      lines.push("");
      lines.push(turn.text.split("\n").map((l) => `> ${l}`).join("\n"));
    }
    lines.push("");
  }
  lines.push("---\n");
  return lines.join("\n");
}

async function main() {
  console.log("Starting smoke real…");
  writeFileSync(OUTPUT_PATH, header());

  const results: AgentResult[] = [];
  for (const sample of SAMPLES) {
    console.log(`\n[${sample.id}] running…`);
    const r = await runOneAgent(sample);
    results.push(r);
    appendFileSync(OUTPUT_PATH, renderResult(r));
    console.log(`  ✓ ${r.transcript.filter((t) => t.role === "agent").length} respostas, ${r.summary.totalTokens} tokens, ${r.summary.avgLatencyMs}ms avg`);
    if (r.summary.errors.length > 0) console.log(`  ⚠ ${r.summary.errors.length} erros`);
  }

  // Resumo final
  let summary = `\n## RESUMO\n\n| Agent | Turns | Tokens | Latência avg | Erros |\n|-------|-------|--------|--------------|-------|\n`;
  for (const r of results) {
    summary += `| ${r.sample.name} | ${r.summary.totalTurns} | ${r.summary.totalTokens} | ${r.summary.avgLatencyMs}ms | ${r.summary.errors.length} |\n`;
  }
  appendFileSync(OUTPUT_PATH, summary);
  console.log(`\nDone! → ${OUTPUT_PATH}`);
}

main().catch((err) => {
  console.error("crashed:", err);
  process.exit(1);
});
