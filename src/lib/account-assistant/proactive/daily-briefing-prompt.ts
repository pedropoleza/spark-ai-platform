/**
 * Prompt template pro Resumo Matinal Diário.
 *
 * Estrutura forçada: emojis fixos + bullets curtos. Tom positivo mas conciso.
 * Pedro 2026-05-12:
 *   - Se deals_closed = [], NÃO mencione "0 deals" — pula a seção
 *   - Idem se appointments_today = [] (pula seção)
 *   - Idem se yesterday tudo zero (pula seção inteira)
 *
 * O context já vem 100% pronto do daily-briefing.ts. LLM SÓ formata,
 * não chama tools. Mantém prompt cache hit alto (system prompt estável).
 */

import type { BriefingContext } from "./daily-briefing";

/**
 * Linhas prontas das duas agendas — o modelo COPIA, não redige.
 *
 * Fix bug observado em prod 2026-08-05: os compromissos do Google chegavam ao
 * LLM (7 no dia do Pedro) e ele resumia tudo em "Dia lotado — workout, almoço e
 * mais alguns", porque o prompt pedia listar E limitava a 10 linhas. Quem lia
 * não via compromisso nenhum. Mesma escola do `booked_label` (H50) e da tabela
 * de datas (H68): dado determinístico quem produz é o código.
 */
function renderAgendas(ctx: BriefingContext): { reunioes: string; compromissos: string } {
  const reunioes = ctx.appointments_today
    .map((a) => {
      const cal = a.calendar_name ? ` (${a.calendar_name})` : "";
      return `• *${a.start_time_label}* — *${a.contact_name}*${cal}`;
    })
    .join("\n");

  const linhas = ctx.blocks_today.map(
    (b) => `• ${b.start_time_label}–${b.end_time_label} — ${b.title}`,
  );
  if (ctx.blocks_truncated_count > 0) {
    linhas.push(`• +${ctx.blocks_truncated_count} outro(s)`);
  }
  return { reunioes, compromissos: linhas.join("\n") };
}

export function buildDailyBriefingPrompt(ctx: BriefingContext): string {
  const sections: string[] = [];
  const { reunioes, compromissos } = renderAgendas(ctx);

  sections.push(
    `Você é o SparkBot, copiloto IA da Spark Leads. Está mandando o RESUMO MATINAL pro rep ${ctx.rep_first_name} via WhatsApp.`,
    "",
    `Hoje: ${ctx.date_label} (${ctx.timezone}).`,
    "",
    "## REGRAS DE FORMATAÇÃO (WhatsApp)",
    "- Comece com saudação contextual + emoji de manhã (☀️🌅).",
    "- Use *negrito* (asterisco simples, NÃO ** duplo) pra destacar nomes/horários.",
    "- Quebra de linha entre seções. Listas em bullets com `•`.",
    "- Cada bullet curto (1 linha). Sem floreio.",
    "- Termine com pergunta aberta curta (1 frase) pra engajar — tipo 'Quer focar em algo específico hoje?' ou 'Precisa de ajuda com alguma reunião?'",
    "- TOM: positivo, motivacional sem ser piegas. Brasileiro natural.",
    "- SEJA CONCISO no que VOCÊ escreve (saudação, transições, pergunta final):",
    "  no máximo 4 linhas suas. As linhas de agenda abaixo NÃO contam nesse limite",
    "  e NÃO podem ser resumidas nem cortadas pra 'economizar espaço'.",
    "",
    "## REGRAS DE CONTEÚDO (CRÍTICAS)",
    "- ❌ SE deals_closed ESTÁ VAZIO: NÃO mencione 'fechou 0 deals' nem 'sem deals'. Pula a linha de deals completa.",
    "- ❌ SE appointments_today ESTÁ VAZIO: NÃO escreva '📅 Nenhuma reunião hoje'. Pula a seção.",
    "- ❌ SE tasks_pending ESTÁ VAZIO: NÃO escreva '✅ Nenhuma tarefa'. Pula.",
    "- ❌ SE yesterday é tudo zero: NÃO mencione 'Ontem você não fez nada'. Pula.",
    "- ✅ Só mencione seções com DADOS reais. Briefing curto é OK.",
    "- ✅ Se TUDO está vazio (improvável — cron pulou se fosse o caso): mande mensagem motivacional curta tipo 'Bom dia! Dia novo, oportunidades novas 🚀'",
    "",
    "## ESTRUTURA SUGERIDA (só se a seção tem dados)",
    "",
    "Saudação:",
    `  ☀️ Bom dia, *${ctx.rep_first_name}*! [opcional: 1 linha contextual sobre o dia, ex: "Hoje é ${ctx.weekday.toLowerCase()} — bom dia pra fechar deals"]`,
    "",
    // As duas agendas vão PRONTAS. O modelo não redige nem resume essas linhas —
    // copia. Evita o "Dia lotado — e mais alguns compromissos" que escondia a
    // agenda inteira do rep.
    reunioes
      ? [
          `Seção 1 — COPIE AS ${ctx.appointments_today.length} LINHA(S) ABAIXO EXATAMENTE COMO ESTÃO,`,
          "uma por linha, sem reescrever, sem resumir, sem cortar nenhuma:",
          `  📅 *${ctx.appointments_today.length} reunião(ões) hoje:*`,
          reunioes.split("\n").map((l) => `  ${l}`).join("\n"),
          "",
        ].join("\n")
      : "Seção 1: appointments_today está vazio — pula a seção inteira (não escreva '📅 nenhuma reunião').",
    "",
    compromissos
      ? [
          `Seção 1b — COPIE AS ${ctx.blocks_today.length} LINHA(S) ABAIXO EXATAMENTE COMO ESTÃO,`,
          "uma por linha. São compromissos do Google Calendar/bloqueios do rep:",
          "  🔒 *Outros compromissos:*",
          compromissos.split("\n").map((l) => `  ${l}`).join("\n"),
          "  ❌ NUNCA misture com a seção 📅 (aquelas são reuniões do Spark Leads).",
          "  ❌ NUNCA troque essa lista por um resumo do tipo 'dia cheio' ou 'e mais alguns'.",
          "",
        ].join("\n")
      : "Seção 1b: blocks_today está vazio — pula a seção inteira.",
    "",
    "Seção 2 (SÓ se tasks_pending.length > 0):",
    "  ✅ *X tarefa(s) pendente(s):*",
    "  • Título da task [se overdue: '(atrasada N dias)']",
    "",
    "Seção 3 (SÓ se yesterday tem algo):",
    "  📊 *Ontem:*",
    "  • [se deals_closed.length > 0]: Fechou N deal(s) — [contato names]",
    "  • [se notes_created > 0]: Criou N nota(s)",
    "  • [se tasks_completed > 0]: Completou N de Y tarefas (use Y só se >0)",
    "",
    "Pergunta final: 1 linha aberta.",
    "",
    "## DADOS DO BRIEFING (json)",
    JSON.stringify(
      {
        rep_first_name: ctx.rep_first_name,
        date_label: ctx.date_label,
        weekday: ctx.weekday,
        appointments_today: ctx.appointments_today,
        blocks_today: ctx.blocks_today,
        blocks_truncated_count: ctx.blocks_truncated_count,
        tasks_pending: ctx.tasks_pending,
        yesterday: ctx.yesterday,
      },
      null,
      2,
    ),
    "",
    "Gera APENAS o texto final da mensagem WhatsApp. Sem JSON, sem explicação meta. Direto a mensagem que o rep vai ler.",
  );

  return sections.join("\n");
}
