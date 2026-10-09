/**
 * H103: replay do MODO REMARCAÇÃO no modelo de produção, com a config REAL dos
 * agentes da Alves Cury (Bruna e Bruno). Não grava nada e não envia nada.
 * Precisa de ANTHROPIC_API_KEY (Vault).
 *   npx tsx scripts/test-remarcacao-llm.ts [rodadas=2]
 *
 * Conversa: o lead agendou com a IA, a equipe assumiu (mensagem humana) e
 * depois chegou o lembrete. Datas relativas a hoje, pra seguir rodável.
 * Cenários: pedir pra remarcar → escolher horário → (fora do assunto) preço,
 * formato da reunião → desmarcar e insistir.
 */
import { config as loadEnv } from "dotenv"; import { resolve } from "path";
loadEnv({ path: resolve(__dirname, "..", ".env.local") });
import { createAdminClient } from "../src/lib/supabase/admin";
import { buildSystemPrompt, buildRuntimeContext, buildResponseJsonSchema } from "../src/lib/ai/sales-prompt-builder";
import { processWithAI, type ConversationTurn } from "../src/lib/ai/openai-client";
import { formatAvailableSlots } from "../src/lib/ai/slots-format";
import {
  prepararRespostaDaRemarcacao,
  rotuloReuniao,
  type ModoRemarcacao,
  type ReuniaoFutura,
} from "../src/lib/queue/remarcacao-pos-handoff";
import type { AgentConfig } from "../src/types/agent";
import type { AIAction } from "../src/types/ai";

const AGENTES = [
  { id: "e698f2b4-92bf-4c6a-9429-dc18ab94096b", nome: "Bruna", tipo: "sales_agent" as const, assunto: "o seguro com benefício em vida" },
  { id: "a0339877-7096-4384-a2d8-34d9daedb339", nome: "Bruno", tipo: "recruitment_agent" as const, assunto: "a oportunidade de ser agente financeiro" },
];
const RODADAS = Number(process.argv[2]) || 2;
const TZ = "America/New_York";
const APT = "aptRemarcacaoTeste0001";
let ok = 0, fail = 0;
const t = (n: string, c: boolean, d = "") => { if (c) { ok++; console.log(`    ✅ ${n}`); } else { fail++; console.log(`    ❌ ${n}${d ? "  → " + d : ""}`); } };

/** "YYYY-MM-DD" do dia (hoje + n) no fuso da conta. */
function diaET(n: number): string {
  const d = new Date(Date.now() + n * 86400_000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}
/** ISO com o offset real de ET naquela data. */
function isoET(ymd: string, hhmm: string): string {
  const parte = new Intl.DateTimeFormat("en-US", { timeZone: TZ, timeZoneName: "shortOffset" })
    .formatToParts(new Date(`${ymd}T16:00:00Z`)).find((p) => p.type === "timeZoneName")?.value || "GMT-4";
  const h = Number((parte.match(/GMT([+-]\d+)/) || [])[1] || -4);
  return `${ymd}T${hhmm}:00${h < 0 ? "-" : "+"}${String(Math.abs(h)).padStart(2, "0")}:00`;
}
const diaDaSemana = (iso: string) => new Intl.DateTimeFormat("pt-BR", { timeZone: TZ, weekday: "long" }).format(new Date(iso)).replace("-feira", "");

(async () => {
  if (!process.env.ANTHROPIC_API_KEY) { console.log("sem ANTHROPIC_API_KEY: rode com a chave do Vault"); process.exit(1); }
  const sb = createAdminClient();

  // Reunião daqui a 4 dias, 19h; horários livres nos 3 dias seguintes.
  const reuniaoIso = isoET(diaET(4), "19:00");
  const slotsIso = [isoET(diaET(5), "15:00"), isoET(diaET(5), "19:00"), isoET(diaET(6), "15:00"), isoET(diaET(6), "19:00"), isoET(diaET(7), "15:00")];
  const slotsResp: Record<string, { slots: string[] }> = {};
  for (const s of slotsIso) (slotsResp[s.slice(0, 10)] ||= { slots: [] }).slots.push(s);
  const availableSlots = formatAvailableSlots(slotsResp, TZ);
  const escolhaIso = slotsIso[3]; // dia +6, 19h
  const diaReuniao = diaDaSemana(reuniaoIso);
  const diaEscolha = diaDaSemana(escolhaIso);
  const agora = new Intl.DateTimeFormat("pt-BR", { timeZone: TZ, dateStyle: "short", timeStyle: "short" }).format(new Date());

  for (const ag of AGENTES) {
    const { data: c } = await sb.from("agent_configs").select("*").eq("agent_id", ag.id).single();
    const cfg = c as AgentConfig;
    const reuniao: ReuniaoFutura = { id: APT, calendarId: cfg.calendar_id || "", startTime: reuniaoIso };
    const modo: ModoRemarcacao = { via: "pedido", tipo: "remarcar", reuniao, rotulo: rotuloReuniao(reuniaoIso, TZ), fuso: "horário do leste" };
    const hist: ConversationTurn[] = [
      { role: "user", content: `Moro nos EUA e gostaria de mais informações sobre ${ag.assunto}` },
      { role: "assistant", content: `Oi Gabi, tudo bem? Aqui é ${ag.nome === "Bruna" ? "a" : "o"} ${ag.nome}, da Alves Cury Financial. Você mora em qual estado?` },
      { role: "user", content: "Flórida" },
      { role: "assistant", content: "Flórida, ótimo. E o que você faz hoje?" },
      { role: "user", content: "Trabalho com limpeza de casas" },
      { role: "assistant", content: `Trabalho puxado esse. A gente faz uma conversa rápida pelo Zoom, uns 30 minutos, sem compromisso. Tem ${diaReuniao}, ${rotuloReuniao(reuniaoIso, TZ).split(", ")[1]}. Pode ser?` },
      { role: "user", content: "Pode sim" },
      { role: "assistant", content: `Fechado. ${rotuloReuniao(reuniaoIso, TZ)}, horário do leste. A confirmação chega por aqui.` },
      { role: "assistant", content: "Oi Gabi, aqui é o Marcos, da Alves Cury. Vou estar com você na reunião. Qualquer dúvida, me chama por aqui." },
      { role: "user", content: "Obrigada Marcos!" },
      { role: "assistant", content: `Lembrete: sua reunião com a Alves Cury é ${rotuloReuniao(reuniaoIso, TZ)} (horário do leste).` },
    ];
    const base = {
      config: cfg, agentType: ag.tipo, contactName: "Gabi", collectedData: {},
      locationName: "Alves Cury Financial", timezone: TZ, currentDate: agora, availableSlots, modoRemarcacao: modo,
    };
    async function turno(h: ConversationTurn[], fala: string) {
      const ctx = { ...base, priorTurnCount: h.length };
      const r = await processWithAI({
        systemPrompt: buildSystemPrompt(ctx), runtimeContext: buildRuntimeContext(ctx),
        conversationMessages: h, conversationHistory: "", newMessages: fala,
        model: cfg.ai_model || "claude-sonnet-4-6", responseSchema: buildResponseJsonSchema(ctx), priorTurnCount: h.length,
      });
      const resp = r.response!;
      const p = prepararRespostaDaRemarcacao(resp, reuniao);
      return { ...p, status: resp.conversation_status, texto: p.message.join(" | ") };
    }
    const acao = (a: AIAction[]) => a[0] ? `${a[0].type} ${a[0].appointment_id} ${a[0].start_time}` : "nenhuma";
    const oferece = (s: string) => /(segunda|ter[cç]a|quarta|quinta|sexta|s[aá]bado|domingo)/i.test(s);
    const qualifica = (s: string) => /qual estado|o que voc[eê] faz|tem fam[ií]lia|documenta|social security|permiss[aã]o de trabalho/i.test(s);

    for (let r = 1; r <= RODADAS; r++) {
      console.log(`\n══ ${ag.nome} · rodada ${r}/${RODADAS} · reunião ${modo.rotulo}`);

      const pedido = `Oi, não vou conseguir ir na ${diaReuniao}, surgiu um trabalho. Dá pra remarcar?`;
      const a = await turno(hist, pedido);
      console.log(`  A. lead: ${pedido}\n     IA: ${a.texto || "(silêncio)"}  [${a.status}; ação: ${acao(a.actions)}]`);
      t("A responde (não fica em silêncio)", !a.silencio);
      t("A oferece horários da lista e não move nada ainda", oferece(a.texto) && a.actions.length === 0, a.texto);
      t("A não volta pra qualificação", !qualifica(a.texto), a.texto);

      const escolha = `Pode ser ${diaEscolha} às 7 da noite`;
      const histB = [...hist, { role: "user" as const, content: pedido }, { role: "assistant" as const, content: a.texto }];
      const b = await turno(histB, escolha);
      console.log(`  B. lead: ${escolha}\n     IA: ${b.texto || "(silêncio)"}  [${b.status}; ação: ${acao(b.actions)}]`);
      t("B move a reunião certa (reschedule com o appointment_id)", b.actions[0]?.type === "reschedule_appointment" && b.actions[0]?.appointment_id === APT, acao(b.actions));
      t("B no horário escolhido", Date.parse(String(b.actions[0]?.start_time)) === Date.parse(escolhaIso), `${b.actions[0]?.start_time} vs ${escolhaIso}`);
      t("B confirma (booked)", b.status === "booked" && !b.silencio, `${b.status}`);

      const histC = [...histB, { role: "user" as const, content: escolha }, { role: "assistant" as const, content: b.texto }];
      const preco = "Quanto custa o seguro mesmo?";
      const c2 = await turno(histC, preco);
      console.log(`  C. lead: ${preco}\n     IA: ${c2.texto || "(silêncio)"}  [${c2.status}]`);
      t("C fora do assunto: silêncio (a equipe responde)", c2.silencio, c2.texto);

      const formato = "Pode ser por ligação em vez de Zoom?";
      const d = await turno(hist, formato);
      console.log(`  D. lead: ${formato}\n     IA: ${d.texto || "(silêncio)"}  [${d.status}]`);
      t("D formato da reunião não é remarcação: silêncio", d.silencio, d.texto);

      const desmarca = "Não vou poder ir, pode cancelar";
      const e = await turno(hist, desmarca);
      console.log(`  E. lead: ${desmarca}\n     IA: ${e.texto || "(silêncio)"}  [${e.status}; ação: ${acao(e.actions)}]`);
      t("E oferece remarcar 1 vez, sem mover nada", !e.silencio && e.actions.length === 0 && e.status !== "handed_off", `${e.status} ${e.texto}`);

      const insiste = "Não, pode cancelar mesmo. Obrigada";
      const histF = [...hist, { role: "user" as const, content: desmarca }, { role: "assistant" as const, content: e.texto }];
      const f = await turno(histF, insiste);
      console.log(`  F. lead: ${insiste}\n     IA: ${f.texto || "(silêncio)"}  [${f.status}; ação: ${acao(f.actions)}]`);
      t("F aceita e passa pra equipe (handed_off), sem mexer na agenda", f.status === "handed_off" && f.actions.length === 0, `${f.status} ${acao(f.actions)}`);
    }
  }
  console.log(`\nRESULTADO: ${ok} ok, ${fail} falhas`);
  process.exit(fail ? 1 : 0);
})();
