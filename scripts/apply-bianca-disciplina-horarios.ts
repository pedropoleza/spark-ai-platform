/**
 * Bianca — disciplina de HORÁRIOS no agente de tráfego pago.
 *
 * Achado no stress de 26/08 (logo depois de a Fase 0 ligar o calendário, que
 * estava vazio desde 18/06 — o caminho de agendamento nunca tinha rodado):
 * com a lista mostrando `Wednesday, August 26` e depois só `Tuesday,
 * September 1`, o agente ofereceu **"quinta, 27/08, às 4:30 PM"** e
 * **"amanhã, quinta"** — datas que NÃO existem na agenda. O dia-da-semana até
 * batia (27/08/2026 é quinta), mas não há horário nenhum nesse dia.
 *
 * É a família H50/H68: o modelo COMPUTA data em vez de COPIAR a que já veio
 * pronta no contexto. Em produção isso vira slot-guard bloqueando o booking
 * (H58) ou lead recebendo dia errado. O prompt só tinha um "nunca invente
 * horário" solto, sem mandar copiar da lista.
 *
 * Bloco ADITIVO, idempotente por marcador, `--revert` remove byte a byte.
 *
 *   npx tsx scripts/apply-bianca-disciplina-horarios.ts [--revert] [--dry]
 */
import { config as env } from "dotenv";
import { resolve } from "path";
env({ path: resolve(__dirname, "..", ".env.local") });
import { createAdminClient } from "@/lib/supabase/admin";

const AGENT_ID = process.argv.find((a) => a.startsWith("--agent="))?.slice(8)
  || "17860a86-ace9-4299-9328-2452151348a0";
const REVERT = process.argv.includes("--revert");
const DRY = process.argv.includes("--dry");

const MARCA = "<!--disciplina-horarios-v1-->";

const BLOCO = `

# DISCIPLINA DE HORÁRIOS (regra dura — vale mais que qualquer outra seção)
A lista de horários disponíveis que vem no seu contexto é a ÚNICA fonte de data e hora que existe. Ela já vem com dia-da-semana, mês e dia prontos.
1. COPIE dia e data EXATAMENTE como aparecem na lista. Não recalcule, não converta, não confira "que dia cai".
2. É PROIBIDO oferecer qualquer dia que não esteja na lista — mesmo que pareça óbvio que existiria. Se a lista pula de quarta pra terça da semana seguinte, é porque não há vaga no meio: NÃO ofereça o que está no vão.
3. NUNCA use "hoje", "amanhã", "semana que vem" ou nome de dia SOZINHO pra marcar. Sempre o dia-da-semana + a data que estão na lista ("quarta, 26/08, às 4 PM ET"). "Amanhã" sem data já colocou gente no dia errado.
4. Ofereça no máximo 2 ou 3 opções, sempre com o fuso (ET).
5. A lista mudou entre um turno e outro? Vale sempre a MAIS RECENTE. Se um horário que você ofereceu sumiu, diga que acabou de ser preenchido e ofereça os que restaram — sem inventar substituto.
6. A pessoa pediu um dia que não está na lista? NÃO agende às cegas e NÃO prometa "vou ver com ela": diga com honestidade que nesse dia não tem vaga aberta, ofereça os da lista e, se nenhum servir, colete a preferência dela + o WhatsApp e passe pro time.
7. Depois de agendar, narre o dia/data/hora EXATAMENTE como voltou do sistema. Nunca recalcule na hora de confirmar.${MARCA}`;

async function main() {
  const sb = createAdminClient();
  const { data } = await sb.from("agent_configs").select("custom_instructions").eq("agent_id", AGENT_ID).single();
  const atual = data?.custom_instructions || "";
  if (!atual) { console.error("❌ agente sem custom_instructions"); process.exit(1); }

  if (REVERT) {
    if (!atual.includes(MARCA)) { console.log("marcador ausente — nada a reverter"); process.exit(0); }
    const limpo = atual.replace(BLOCO, "");
    if (DRY) { console.log(`(dry) removeria ${atual.length - limpo.length} chars`); process.exit(0); }
    await sb.from("agent_configs").update({ custom_instructions: limpo, updated_at: new Date().toISOString() }).eq("agent_id", AGENT_ID);
    console.log(`↩️  REVERTIDO: ${atual.length} → ${limpo.length} chars`);
    process.exit(0);
  }

  if (atual.includes(MARCA)) {
    console.log(`✔️  bloco já aplicado (${atual.length} chars) — nada a fazer`);
    process.exit(0);
  }

  const novo = atual + BLOCO;
  if (novo.length > 8000) {
    // O zod trava custom_instructions em 8000 (F31). Se estourar, é sinal de
    // que o prompt precisa de compressão antes — não de aumentar o limite.
    console.error(`❌ passaria de 8000 chars (${novo.length}) — o zod barra no save do painel. Comprimir antes.`);
    process.exit(1);
  }
  if (DRY) { console.log(`(dry) ${atual.length} → ${novo.length} chars`); console.log(BLOCO); process.exit(0); }

  const { error } = await sb.from("agent_configs")
    .update({ custom_instructions: novo, updated_at: new Date().toISOString() })
    .eq("agent_id", AGENT_ID);
  if (error) { console.error("❌", error.message); process.exit(1); }

  const { data: check } = await sb.from("agent_configs").select("custom_instructions").eq("agent_id", AGENT_ID).single();
  const ok = (check?.custom_instructions || "").includes(MARCA);
  console.log(`${ok ? "✅" : "❌"} bloco aplicado: ${atual.length} → ${(check?.custom_instructions || "").length} chars`);
  console.log("Rollback: npx tsx scripts/apply-bianca-disciplina-horarios.ts --revert");
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error("ERR:", e?.message || e); process.exit(1); });
