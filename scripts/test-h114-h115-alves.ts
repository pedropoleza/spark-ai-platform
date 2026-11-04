/**
 * H114 + H115 (caso Alves Cury 03-04/11/2026): gatilho espera a 1ª mensagem,
 * formulário no contexto, guardas de agenda e fuso, temperature por modelo.
 * Rodar: npx tsx scripts/test-h114-h115-alves.ts
 */
import { agruparMensagensDaFila, type QueuedMessage } from "@/lib/queue/queue-processor";
import { GATILHO_ESPERA_MS, isReactiveTriggerBody } from "@/lib/account-assistant/proactive/reactive-trigger";
import { loteTemMensagemDoLead } from "@/lib/queue/entry-by-automation";
import { extrairFormularioDoLead } from "@/lib/queue/lead-form";
import { buildLeadHistorySection, buildRuntimeContext } from "@/lib/ai/sales-prompt-builder";
import { formatAvailableSlots } from "@/lib/ai/slots-format";
import { claudeAceitaTemperatura } from "@/lib/ai/openai-client";
import { aplicarGuardasDeAgenda } from "@/lib/queue/agenda-guard";
import { aplicarGuardaDeRecapAgendado } from "@/lib/queue/lead-day-guard";
import type { AIResponse } from "@/types/ai";

let pass = 0, fail = 0;
const ok = (nome: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✅ ${nome}`); }
  else { fail++; console.log(`  ❌ ${nome}`, extra !== undefined ? JSON.stringify(extra).slice(0, 400) : ""); }
};
const ET = "America/New_York";
const CT = "America/Chicago";

async function main() {
  console.log("\n1) H114: gatilho e mensagem do formulário no mesmo lote");
  {
    const linhas = [
      { id: "1", agent_id: "bruna", location_id: "loc", contact_id: "c1", conversation_id: "", channel: "SMS", message_body: "__reactive_trigger__:custom_field_changed:activated", message_direction: "system" },
      { id: "2", agent_id: "bruna", location_id: "loc", contact_id: "c1", conversation_id: "conv-1", channel: "WhatsApp", message_body: "*Headline:* Aposentadoria\nHello! I filled out your form", message_direction: "inbound" },
      { id: "3", agent_id: "bruno", location_id: "loc", contact_id: "c1", conversation_id: "conv-1", channel: "WhatsApp", message_body: "oi", message_direction: "inbound" },
    ] as unknown as QueuedMessage[];
    const g = agruparMensagensDaFila(linhas);
    const bruna = g.get("bruna:c1");
    ok("um lote por agente (Bruna e Bruno separados)", g.size === 2);
    ok("lote da Bruna tem o gatilho e a mensagem", bruna?.messages.length === 2);
    ok("conversa vem da mensagem do lead", bruna?.conversationId === "conv-1", bruna?.conversationId);
    ok("canal vem da mensagem do lead (WhatsApp, não o SMS do gatilho)", bruna?.channel === "WhatsApp", bruna?.channel);
    ok("lote misto tem mensagem do lead", loteTemMensagemDoLead(bruna!.messages, isReactiveTriggerBody));
    ok("lote só com gatilho não tem", !loteTemMensagemDoLead([linhas[0]], isReactiveTriggerBody));
    ok("espera do gatilho entre 30 e 60 s", GATILHO_ESPERA_MS >= 30_000 && GATILHO_ESPERA_MS <= 60_000, GATILHO_ESPERA_MS);
  }

  console.log("\n2) Formulário do lead no contexto (contato real da Âna)");
  {
    const nomes = new Map([
      ["3mRflN2U1rkiTQpvOKEk", "Em que fase você está hoje?"],
      ["9JQnwuzbZjySisthrTNq", "Em quanto tempo você imagina se aposentar?"],
      ["eJHlxLU18flFV7bZHwyH", "Qual é o seu principal objetivo?"],
      ["C7LzKTXG3QHJuzfqOi9T", "AI"],
    ]);
    const contato = {
      attributionSource: { formName: "Aposentadoria e Planejamento Financeiro - Form", campaign: "Produto - Leads Qualificado - Form", utmContent: "Planejamento aposentadoria" },
      customFields: [
        { id: "3mRflN2U1rkiTQpvOKEk", value: "Só estou pesquisando por enquanto" },
        { id: "9JQnwuzbZjySisthrTNq", value: "De 10 a 20 anos" },
        { id: "eJHlxLU18flFV7bZHwyH", value: "Planejar minha aposentadoria" },
        { id: "C7LzKTXG3QHJuzfqOi9T", value: "Venda" },
      ],
    };
    const f = extrairFormularioDoLead(contato, nomes);
    ok("nome do formulário", f?.nome === "Aposentadoria e Planejamento Financeiro - Form", f);
    ok("3 respostas (o campo AI não é pergunta)", f?.respostas.length === 3, f?.respostas);
    ok("atribuição mais recente vence", extrairFormularioDoLead({ attributionSource: { formName: "antigo" }, lastAttributionSource: { formName: "novo" } }, nomes)?.nome === "novo");
    ok("contato sem nada: null", extrairFormularioDoLead({ customFields: [{ id: "C7LzKTXG3QHJuzfqOi9T", value: "Venda" }] }, nomes) === null);

    const ctxBase = {
      config: { timezone_config: { auto_detect_from_state: true } } as never,
      contactName: "Âna",
      collectedData: {},
      locationName: "Alves Cury",
      currentDate: "x",
      timezone: ET,
      leadHistory: {
        contact: { id: "c", name: "Âna", tags: [], customFields: [] },
        recent_messages: [], notes: [], opportunities: [],
        last_human_outbound_at: null, last_inbound_at: null, has_closed_opp: false, fetch_ms: 1,
        formulario: f,
      },
    };
    const sec = buildLeadHistorySection(ctxBase as never);
    ok("seção aparece mesmo sem mensagens", sec.includes("Formulário que o lead preencheu"), sec);
    ok("traz o objetivo do lead", sec.includes("Qual é o seu principal objetivo? Planejar minha aposentadoria"), sec);
  }

  console.log("\n3) Lista de horários com o fuso do lead e a seção FUSO DO LEAD");
  {
    const slots = { "2026-11-06": { slots: ["2026-11-06T09:30:00-05:00", "2026-11-06T14:00:00-05:00"] } };
    const semFuso = formatAvailableSlots(slots, ET);
    ok("sem fuso do lead: igual a antes", /9:30 AM, 2:00 PM$/.test(semFuso), semFuso);
    const comFuso = formatAvailableSlots(slots, ET, 30, CT);
    ok("com CT: '2:00 PM ET (1:00 PM CT)'", comFuso.includes("2:00 PM ET (1:00 PM CT)"), comFuso);
    const rt = buildRuntimeContext({
      config: { objective: "booking", data_fields: [], timezone_config: { auto_detect_from_state: true, use_location_default: true } } as never,
      contactName: "Izolis", collectedData: {}, locationName: "Alves", currentDate: "x", timezone: ET,
      availableSlots: comFuso, fusoLead: { tz: CT, origem: "Austin, Texas" },
    } as never);
    ok("runtime tem FUSO DO LEAD com a diferença", rt.includes("### FUSO DO LEAD") && rt.includes("1h a menos"), rt.slice(rt.indexOf("### FUSO")));
    const rtEt = buildRuntimeContext({
      config: { objective: "booking", data_fields: [], timezone_config: { auto_detect_from_state: true, use_location_default: true } } as never,
      contactName: "x", collectedData: {}, locationName: "Alves", currentDate: "x", timezone: ET,
      availableSlots: semFuso, fusoLead: { tz: ET, origem: "Flórida" },
    } as never);
    ok("lead no mesmo fuso: sem a seção", !rtEt.includes("### FUSO DO LEAD"));
  }

  console.log("\n4) temperature só para quem aceita");
  ok("sonnet 4.6 aceita", claudeAceitaTemperatura("claude-sonnet-4-6"));
  ok("haiku 4.5 datado aceita", claudeAceitaTemperatura("claude-haiku-4-5-20251001"));
  ok("opus 4.6 aceita", claudeAceitaTemperatura("claude-opus-4-6"));
  ok("sonnet 5 recusa", !claudeAceitaTemperatura("claude-sonnet-5"));
  ok("sonnet 5.5 recusa", !claudeAceitaTemperatura("claude-sonnet-5-5"));
  ok("opus 4.7 recusa", !claudeAceitaTemperatura("claude-opus-4-7"));
  ok("opus 5.5 recusa", !claudeAceitaTemperatura("claude-opus-5-5"));

  console.log("\n5) Guarda de agenda (com o modelo simulado)");
  const AGORA = new Date("2026-11-04T01:40:00Z");
  const SLOTS = ["2026-11-05T20:00:00-05:00", "2026-11-06T14:00:00-05:00", "2026-11-06T15:00:00-05:00", "2026-11-06T16:00:00-05:00", "2026-11-09T20:00:00-05:00"];
  const resp = (message: string[], actions: AIResponse["actions"] = []): AIResponse =>
    ({ message, should_send_message: true, actions, internal_notes: "", collected_data: {}, conversation_status: "active" });
  {
    let chamadas = 0;
    const r = await aplicarGuardasDeAgenda({
      resposta: resp(["Tem quinta-feira, 05/11, às 3 da tarde ET ou sexta-feira, 06/11, às 8 da noite ET. Qual funciona melhor?"]),
      slotsIso: SLOTS, fusoLista: ET, fusoLead: null, mensagemDoLead: "Sou nanny", pularOferta: false, agora: AGORA,
      regenerar: async (d) => { chamadas++; ok("diretiva cita a oferta inventada e os horários reais", d.includes("NÃO existe na agenda") && d.includes("sexta-feira, 06/11")); return resp(["Tenho quinta-feira, 05/11, às 8 da noite ET ou sexta-feira, 06/11, às 2 da tarde ET. Qual prefere?"]); },
    });
    ok("refez 1 vez e ficou com a resposta válida", chamadas === 1 && r.regenerou && !r.ofertaSubstituida, r);
  }
  {
    const r = await aplicarGuardasDeAgenda({
      resposta: resp(["Oi!", "Tenho sexta-feira, 06/11, às 8 da noite ET. Pode ser?"]),
      slotsIso: SLOTS, fusoLista: ET, fusoLead: null, mensagemDoLead: "", pularOferta: false, agora: AGORA, preferirTardeNoite: true,
      regenerar: async () => resp(["Oi!", "Tenho sexta-feira, 06/11, às 8 da noite ET. Pode ser?"]),
    });
    const m = r.resposta.message as string[];
    ok("insistiu: vira a oferta determinística, a 1ª bolha fica", r.ofertaSubstituida && m[0] === "Oi!" && /^Tenho quinta-feira, 05\/11, às 8 da noite ET ou sexta-feira, 06\/11/.test(m[1]), m);
  }
  {
    const r = await aplicarGuardasDeAgenda({
      resposta: resp(["Fechado, Izolis! Sexta-feira, 06/11, às 2 PM, horário do leste (ET)."], [{ type: "book_appointment", start_time: "2026-11-06T14:00:00-05:00", calendar_id: "cal" }]),
      slotsIso: SLOTS, fusoLista: ET, fusoLead: null, mensagemDoLead: "Pode ser sexta\n2 PM\nDE AUSTIN", pularOferta: false, agora: AGORA,
      regenerar: async (d) => {
        ok("diretiva explica 2 PM de Austin = 3 PM ET", d.includes("3 PM ET"), d);
        return resp(["Fechado, Izolis! Sexta-feira, 06/11, às 2 da tarde no seu horário (3 PM ET)."], [{ type: "book_appointment", start_time: "2026-11-06T15:00:00-05:00", calendar_id: "cal" }]);
      },
    });
    ok("refeito agenda 15:00 ET", r.regenerou && !r.agendamentoRetirado && r.resposta.actions[0]?.start_time === "2026-11-06T15:00:00-05:00", r.resposta.actions);
  }
  {
    const errado = resp(["Fechado! Sexta às 2 PM ET."], [{ type: "book_appointment", start_time: "2026-11-06T14:00:00-05:00", calendar_id: "cal" }]);
    const r = await aplicarGuardasDeAgenda({
      resposta: errado, slotsIso: SLOTS, fusoLista: ET, fusoLead: null, mensagemDoLead: "Pode ser sexta 2 PM DE AUSTIN", pularOferta: false, agora: AGORA,
      regenerar: async () => errado,
    });
    const m = (r.resposta.message as string[])[0];
    ok("insistiu: NÃO agenda e pergunta com os dois fusos", r.agendamentoRetirado && r.resposta.actions.length === 0 && m.includes("3 da tarde no horário do leste (ET)"), m);
  }
  {
    const r = await aplicarGuardasDeAgenda({
      resposta: resp(["Fechado! Sexta, 06/11, às 2 da tarde no seu horário (3 PM ET)."], [{ type: "book_appointment", start_time: "2026-11-06T15:00:00-05:00", calendar_id: "cal" }]),
      slotsIso: SLOTS, fusoLista: ET, fusoLead: CT, mensagemDoLead: "Pode ser sexta 2 PM DE AUSTIN", pularOferta: false, agora: AGORA,
      regenerar: async () => { throw new Error("não devia refazer"); },
    });
    ok("certo de primeira: não mexe", r.notas.length === 0 && !r.regenerou, r.notas);
  }
  {
    const r = await aplicarGuardasDeAgenda({
      resposta: resp(["Antes de marcar, assiste o vídeo?", "Tenho quinta às 10h, se quiser."]),
      slotsIso: [], fusoLista: ET, fusoLead: null, mensagemDoLead: "quero marcar", pularOferta: false, agora: AGORA,
      regenerar: async (d) => { ok("agenda travada: diretiva proíbe dia e hora", d.includes("NÃO cite dia nem hora")); return resp(["Antes de marcar, assiste o vídeo?", "Tenho quinta às 10h, se quiser."]); },
    });
    const m = r.resposta.message as string[];
    ok("insistiu sem agenda: a frase com horário sai", m.length === 1 && m[0] === "Antes de marcar, assiste o vídeo?", m);
  }

  console.log("\n6) Confirmação do agendamento no horário do lead");
  {
    const certo = aplicarGuardaDeRecapAgendado(["Fechado! Sexta, 06/11, às 2 da tarde no seu horário (3 PM ET)."], "2026-11-06T15:00:00-05:00", ET, { fusoLead: CT, siglaConta: "ET" });
    ok("hora local + ET entre parênteses: aceita", !certo.changed, certo);
    const errado = aplicarGuardaDeRecapAgendado(["Fechado! Sexta às 2 PM ET."], "2026-11-06T15:00:00-05:00", ET, { fusoLead: CT, siglaConta: "ET", sufixoFuso: "horário do leste" });
    ok("hora errada: rótulo fala os dois fusos", errado.changed && errado.messages[0].includes("às 2 da tarde no seu horário (3 PM ET)"), errado.messages);
    const semFuso = aplicarGuardaDeRecapAgendado(["Fechado! Sexta às 2 PM ET."], "2026-11-06T15:00:00-05:00", ET, { sufixoFuso: "horário do leste" });
    ok("sem fuso do lead: igual a antes (rótulo ET)", semFuso.changed && semFuso.messages[0].includes("às 3 da tarde, horário do leste"), semFuso.messages);
  }

  console.log(`\n${pass} ok · ${fail} falhas`);
  process.exit(fail > 0 ? 1 : 0);
}
main();
