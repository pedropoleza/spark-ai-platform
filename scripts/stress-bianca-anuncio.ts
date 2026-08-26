/**
 * Bateria do agente de TRÁFEGO PAGO da Bianca — foco no que MUDOU na Fase 0.
 *
 * O ponto crítico: o `calendar_id` estava VAZIO desde 18/06 com
 * objective=qualification_and_booking, então este agente NUNCA agendou nada em
 * produção. A Fase 0 ligou o calendário 1:1 + janela de 14 dias. Este teste
 * prova que o caminho de agendamento funciona e que ele só oferece horário REAL
 * (o H58 bloqueia data inventada — melhor pegar aqui do que em prod).
 *
 * LLM real, endpoint de teste → ZERO envio. execute_actions=false: nada é
 * gravado no calendário da Bianca.
 *
 *   npx tsx scripts/stress-bianca-anuncio.ts
 */
import { config } from "dotenv";
config({ path: process.env.STRESS_ENV_FILE || "/tmp/.prodenv-stress" });
import { SignJWT } from "jose";
import { writeFileSync } from "fs";

const BASE = process.env.STRESS_BASE || "https://spark-ai-platform.vercel.app";
const AGENT_ID = "17860a86-ace9-4299-9328-2452151348a0";
const LOC = "cRavIlyC52vFYgJATgi7";

async function jwt(): Promise<string> {
  const secret = new TextEncoder().encode(process.env.JWT_SECRET!);
  return new SignJWT({
    userId: "stress-bianca-ads",
    companyId: process.env.NEXT_PUBLIC_GHL_COMPANY_ID || "TdmQMjj86Y3LgppiB96K",
    locationId: LOC, locationName: "Five Rings", isAdmin: true,
  }).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("2h").sign(secret);
}

async function turno(token: string, sid: string | null, msg: string) {
  const r = await fetch(`${BASE}/api/agents/test`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `spark_session=${token}` },
    body: JSON.stringify({ agent_id: AGENT_ID, message: msg, ...(sid ? { session_id: sid } : {}) }),
  });
  const j = (await r.json()) as Record<string, unknown>;
  if (!r.ok || j.error) throw new Error(`HTTP ${r.status}: ${JSON.stringify(j).slice(0, 250)}`);
  const resp = (j.response || {}) as { message?: unknown; actions?: Array<Record<string, unknown>> };
  const bolhas = Array.isArray(resp.message) ? resp.message : resp.message ? [resp.message] : [];
  return {
    sid: String(j.session_id),
    texto: bolhas.join("\n"),
    bolhas,
    actions: resp.actions || [],
    slots: String(j.available_slots || ""),
  };
}

const FLUXO = [
  "Sim! Quero me tornar um Agente Financeiro nos Estados Unidos,",
  "moro na Florida",
  "tenho green card sim",
  "trabalho de uber hoje, mas to cansado da estrada",
  "quero uma renda melhor e mais tempo com meus filhos",
  "pode ser sim, quando tem horario?",
];

async function main() {
  if (!process.env.JWT_SECRET) { console.error("❌ JWT_SECRET ausente"); process.exit(1); }
  const token = await jwt();
  let sid: string | null = null;
  let fail = 0, pass = 0;
  const rel: string[] = ["# Stress — Bianca Tráfego Pago (pós-Fase 0)\n"];
  let slotsVistos = "";
  // Todo texto do bot, turno a turno — a versão anterior só checava o ÚLTIMO
  // turno e por isso passou vazia enquanto o agente inventava "quinta, 27/08"
  // no meio da conversa (26/08).
  const todosOsTurnos: { msg: string; texto: string; slots: string }[] = [];

  for (const msg of FLUXO) {
    const r = await turno(token, sid, msg);
    sid = r.sid;
    if (r.slots) slotsVistos = r.slots;
    todosOsTurnos.push({ msg, texto: r.texto, slots: r.slots || slotsVistos });
    console.log(`\nLEAD: ${msg}`);
    r.bolhas.forEach((b) => console.log(`  BOT: ${b}`));
    if (r.actions.length) console.log(`  AÇÕES: ${r.actions.map((a) => a.type).join(", ")}`);
    rel.push(`\n**LEAD:** ${msg}\n`);
    r.bolhas.forEach((b) => rel.push(`> ${b}\n`));
    await new Promise((res) => setTimeout(res, 700));
  }

  const check = (nome: string, ok: boolean) => {
    if (ok) pass++; else fail++;
    console.log(`${ok ? "✅" : "🔴"} ${nome}`);
    if (!ok) rel.push(`- 🔴 ${nome}\n`);
  };

  console.log("\n=== CHECAGENS ===");
  // O ponto central da Fase 0: o contexto agora TEM horários.
  check("contexto traz horários reais (calendar_id ligado na Fase 0)", slotsVistos.trim().length > 0);
  const ultimo = await turno(token, sid, "pode ser o primeiro horario que vc falou");
  console.log(`\nLEAD: pode ser o primeiro horario que vc falou`);
  ultimo.bolhas.forEach((b) => console.log(`  BOT: ${b}`));
  console.log(`  AÇÕES: ${ultimo.actions.map((a) => a.type).join(", ") || "(nenhuma)"}`);
  rel.push(`\n**LEAD:** pode ser o primeiro horario que vc falou\n`);
  ultimo.bolhas.forEach((b) => rel.push(`> ${b}\n`));

  todosOsTurnos.push({ msg: "pode ser o primeiro horario que vc falou", texto: ultimo.texto, slots: ultimo.slots || slotsVistos });
  const textoTudo = ultimo.texto;

  // ── A checagem que importa: TODA data dd/mm citada em QUALQUER turno tem que
  // existir na lista daquele turno. É o defeito real medido em 26/08.
  const MES: Record<string, number> = { January: 1, February: 2, March: 3, April: 4, May: 5, June: 6, July: 7, August: 8, September: 9, October: 10, November: 11, December: 12 };
  const inventadas: string[] = [];
  for (const t of todosOsTurnos) {
    const disponiveis = new Set(
      [...t.slots.matchAll(/(\w+day), (\w+) (\d{1,2})/g)].map((m) => `${Number(m[3])}/${MES[m[2]] ?? 0}`),
    );
    if (disponiveis.size === 0) continue; // sem lista no turno = inconclusivo
    for (const m of t.texto.matchAll(/(\d{1,2})\/(\d{1,2})/g)) {
      const chave = `${Number(m[1])}/${Number(m[2])}`;
      if (!disponiveis.has(chave)) inventadas.push(`"${m[0]}" (turno: ${t.msg.slice(0, 32)}…)`);
    }
  }
  check(
    `NENHUMA data fora da lista em nenhum turno${inventadas.length ? ` — inventou: ${inventadas.join(" · ")}` : ""}`,
    inventadas.length === 0,
  );
  // "amanhã/hoje" como substituto de data também já pôs gente no dia errado.
  const relativos = todosOsTurnos.filter((t) => /\b(amanh[ãa]|depois de amanh[ãa])\b/i.test(t.texto));
  check(
    `não usa "amanhã" no lugar da data${relativos.length ? ` — ${relativos.length} turno(s)` : ""}`,
    relativos.length === 0,
  );
  // Coletar o WhatsApp ANTES de confirmar é comportamento correto do prompt
  // dele (aceite real → coleta → confirma), não falha.
  check(
    "avança pro fechamento (agenda OU pede contato antes de confirmar)",
    /book_appointment/.test(JSON.stringify(ultimo.actions)) || /(marcad|agendad|confirmad|te espero|fechado|whats|contato)/i.test(textoTudo),
  );
  check("sem token cru", !/(\{\{|\}\}|\[nome\]|\[link)/i.test(textoTudo));
  check("sem promessa de email/WhatsApp", !/(te mando|te envio|te aviso).{0,30}(email|e-mail|whats)/i.test(textoTudo));
  check("sem número de renda", !/(\$\s?\d|\d+\s?(mil|k\b))/i.test(textoTudo));

  console.log(`\n--- horários que o agente enxergou ---\n${slotsVistos.slice(0, 400) || "(nenhum)"}`);
  rel.push(`\n## Horários no contexto\n\n\`\`\`\n${slotsVistos.slice(0, 600)}\n\`\`\`\n`);
  rel.push(`\n---\n\n**${pass}/${pass + fail}**\n`);
  const arq = `_planning/bianca-agentes-2026-08/stress-anuncio-${Date.now()}.md`;
  writeFileSync(arq, rel.join(""));
  console.log(`\nRESULTADO: ${pass}/${pass + fail} · relatório: ${arq}`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error("FATAL:", e?.message || e); process.exit(1); });
