/**
 * H108 (caso Ana Gusmão #456, 2026-10-26): cadastro e agendamento do SparkBot.
 *
 * Reproduz a conversa real das 9:24 às 9:28 ET (dados de terceiros anonimizados:
 * telefones viraram 555, candidatos da busca viraram nomes genéricos):
 *  1. busca "Filipe Sonoplasta" voltou candidatos de confiança baixa;
 *  2. a Ana digitou o telefone do Filipe;
 *  3. o bot criou o contato com o telefone do 1º CANDIDATO e assigned_to "self" (404);
 *  4. o agendamento foi com 30 min num calendário que só aceita 60, e o
 *     calendário foi passado pelo NOME.
 *
 * Rodar: npx tsx -r tsconfig-paths/register scripts/test-sparkbot-contato-agenda-h108.ts
 */
import { CONTACTS_TOOLS, conferirDadoDigitado } from "@/lib/account-assistant/tools/contacts";
import {
  CALENDAR_TOOLS,
  ajustarDuracaoAoCalendario,
  resolverCalendarioId,
} from "@/lib/account-assistant/tools/calendar";
import { validateGhlId, type ToolContext } from "@/lib/account-assistant/tools/types";
import { extractPendingSubject } from "@/lib/account-assistant/contact-resolver/pending-subject";
import {
  extractTypedPhones,
  extractTypedEmails,
  mesmoTelefone,
} from "@/lib/account-assistant/contact-resolver/typed-data";

let pass = 0;
let fail = 0;
function check(nome: string, cond: boolean, detalhe?: unknown) {
  if (cond) {
    pass++;
    console.log(`  ✅ ${nome}`);
  } else {
    fail++;
    console.log(`  ❌ ${nome}${detalhe !== undefined ? ` (${typeof detalhe === "string" ? detalhe : JSON.stringify(detalhe)})` : ""}`);
  }
}

const LOC = "LocVergus00000000001";
const ANA_USER = "AnaUserGhl0000000001";
const CAL_ID = "CalConsultoria000001";
const CAL_REVISAO = "CalRevisaoAnual00001";
const TEL_FILIPE = "+18435550137"; // o que a Ana digitou (real: outro número, mesmo formato)
const TEL_CANDIDATO = "+19545550111"; // 1º candidato da busca, OUTRA pessoa
const FALA_ANA =
  '🎤 "Preciso marcar pra terça-feira, amanhã, às cinco e meia da tarde, com o Filipe Sonoplasta."\n' +
  "+1 (843) 555-0137";

// O preview REAL de 9:24:17 tinha esta forma (search_contacts, confiança baixa).
const PREVIEW_BUSCA_BAIXA =
  '{"status":"ok","data":{"contacts":[{"id":"CandidatoUm000000001","name":"filipe candidato um - grupo x",' +
  '"email":null,"phone":"+19545550111","tags":[],"last_activity":"2026-09-22T02:21:21.520Z","match_score":0.51},' +
  '{"id":"CandidatoDois0000001","name":"filipe candidato dois","email":"cand2@exemplo.com","phone":"+17545550122",' +
  '"tags":["client"],"match_score":0.425}],"best_match":{"id":"CandidatoUm000000001","score":0.51,"gap":0.085},' +
  '"confidence":"low","complete":true,"total_retur';

interface Chamada {
  metodo: "get" | "post" | "put";
  path: string;
  body?: Record<string, unknown>;
  params?: Record<string, string>;
}

function makeCtx(opts: {
  repMessage?: string | null;
  repUser?: string | null;
  donos?: Record<string, { id: string; firstName?: string; lastName?: string }>;
  dupFalha?: boolean;
  calendarios?: Array<{ id: string; name: string; widgetSlug?: string; isActive?: boolean; teamMembers?: Array<{ userId: string }> }>;
  durationOptions?: Array<{ duration: number; durationUnit: string; isDefault?: boolean }>;
  pref?: { default_calendar_id?: string; default_calendar_name?: string };
}): { ctx: ToolContext; chamadas: Chamada[] } {
  const chamadas: Chamada[] = [];
  const donos = opts.donos || {};
  const calendarios = opts.calendarios || [
    { id: CAL_ID, name: "Consultoria de Seguros (Produtos)", widgetSlug: "consultoria-seguros", teamMembers: [{ userId: ANA_USER }] },
    { id: CAL_REVISAO, name: "Revisão Anual de Apólice", widgetSlug: "revisao-anual", teamMembers: [{ userId: ANA_USER }] },
  ];
  const ctx = {
    rep: {
      id: "rep-ana",
      phone: "+15550001111",
      is_internal: false,
      timezone: "America/New_York",
      ghl_users: opts.repUser === null ? [] : [{ location_id: LOC, ghl_user_id: opts.repUser ?? ANA_USER, role: "admin" }],
      profile: { preferences: { scheduling: opts.pref ?? { default_calendar_id: CAL_ID, default_calendar_name: "Consultoria de Seguros (Produtos)" } } },
    },
    locationId: LOC,
    companyId: "CompanyX00000000001",
    repMessage: opts.repMessage === undefined ? FALA_ANA : opts.repMessage,
    repTz: "America/New_York",
    ghlClient: {
      get: async (path: string, params?: Record<string, string>) => {
        chamadas.push({ metodo: "get", path, params });
        if (path === "/contacts/search/duplicate") {
          if (opts.dupFalha) throw new Error("GHL API 500: fora do ar");
          const chave = params?.number ? String(params.number).replace(/\D/g, "").slice(-10) : String(params?.email || "");
          const dono = Object.entries(donos).find(([k]) => k.replace(/\D/g, "").slice(-10) === chave || k === chave)?.[1];
          return { contact: dono || null, traceId: "t" };
        }
        if (path === "/calendars/") return { calendars: calendarios };
        if (path.startsWith("/calendars/")) {
          return {
            calendar: {
              name: "Consultoria de Seguros (Produtos)",
              teamMembers: [{ userId: ANA_USER }],
              slotDuration: 60,
              slotDurationUnit: "mins",
              ...(opts.durationOptions ? { durationOptions: opts.durationOptions } : {}),
            },
          };
        }
        if (/^\/contacts\/[^/]+\/appointments$/.test(path)) return { events: [] };
        return {};
      },
      post: async (path: string, body: Record<string, unknown>) => {
        chamadas.push({ metodo: "post", path, body });
        if (path === "/contacts/") return { contact: { id: "ContatoNovo000000001" } };
        if (path === "/calendars/events/appointments") return { id: "ApptNovo000000000001", assignedUserId: body.assignedUserId };
        return {};
      },
      put: async (path: string, body: Record<string, unknown>) => {
        chamadas.push({ metodo: "put", path, body });
        return {};
      },
    },
  } as unknown as ToolContext;
  return { ctx, chamadas };
}

const createContact = CONTACTS_TOOLS.find((t) => t.def.name === "create_contact")!;
const updateContact = CONTACTS_TOOLS.find((t) => t.def.name === "update_contact")!;
const createAppointment = CALENDAR_TOOLS.find((t) => t.def.name === "create_appointment")!;
const posts = (c: Chamada[], path: string) => c.filter((x) => x.metodo === "post" && x.path === path);

async function main() {
  // -------------------------------------------------------------------------
  console.log("\n1. assigned_to 'self' vira o usuário do rep (causa do 404)");
  // -------------------------------------------------------------------------
  for (const palavra of ["self", "me", "eu", "SELF"]) {
    const { ctx, chamadas } = makeCtx({});
    const r = await createContact.handler(ctx, { first_name: "Filipe", last_name: "Sonoplasta", phone: TEL_FILIPE, assigned_to: palavra });
    const p = posts(chamadas, "/contacts/")[0];
    check(`create_contact assigned_to='${palavra}' manda o id da Ana`, r.status === "ok" && p?.body?.assignedTo === ANA_USER, p?.body);
  }
  {
    const { ctx, chamadas } = makeCtx({});
    await createContact.handler(ctx, { first_name: "Filipe", phone: TEL_FILIPE, assigned_to: "OutroUserGhl00000001" });
    check("id real de outro usuário passa como veio", posts(chamadas, "/contacts/")[0]?.body?.assignedTo === "OutroUserGhl00000001");
  }
  {
    const { ctx, chamadas } = makeCtx({});
    const r = await createContact.handler(ctx, { first_name: "Filipe", phone: TEL_FILIPE, assigned_to: "Ana" });
    check("assigned_to inválido ('Ana') volta erro e não cria", r.status === "error" && posts(chamadas, "/contacts/").length === 0, r);
  }
  {
    const { ctx, chamadas } = makeCtx({ repUser: null });
    const r = await createContact.handler(ctx, { first_name: "Filipe", phone: TEL_FILIPE, assigned_to: "self" });
    const p = posts(chamadas, "/contacts/")[0];
    check("rep sem usuário na conta: 'self' é omitido (nunca vai cru)", r.status === "ok" && p && !("assignedTo" in (p.body || {})), p?.body);
  }
  {
    const { ctx, chamadas } = makeCtx({});
    await createContact.handler(ctx, { first_name: "Filipe", phone: TEL_FILIPE });
    check("sem assigned_to: corpo sem assignedTo (como antes)", !("assignedTo" in (posts(chamadas, "/contacts/")[0]?.body || {})));
  }
  {
    const { ctx, chamadas } = makeCtx({});
    const r = await updateContact.handler(ctx, { contact_id: "ContatoExistente0001", assigned_to: "self" });
    const p = chamadas.find((x) => x.metodo === "put");
    check("update_contact assigned_to='self' manda o id da Ana", r.status === "ok" && p?.body?.assignedTo === ANA_USER, p?.body);
  }
  {
    const { ctx, chamadas } = makeCtx({});
    const r = await updateContact.handler(ctx, { contact_id: "ContatoExistente0001", assigned_to: "x" });
    check("update_contact assigned_to inválido volta erro e não grava", r.status === "error" && !chamadas.some((x) => x.metodo === "put"), r);
  }

  // -------------------------------------------------------------------------
  console.log("\n2. CASO FILIPE: o telefone que a Ana digitou vence o do candidato da busca");
  // -------------------------------------------------------------------------
  const donos = { [TEL_CANDIDATO]: { id: "CandidatoUm000000001", firstName: "Filipe", lastName: "Candidato Um - grupo X" } };
  {
    const { ctx, chamadas } = makeCtx({ donos });
    const r = await createContact.handler(ctx, {
      first_name: "Filipe",
      last_name: "Sonoplasta",
      phone: TEL_CANDIDATO,
      assigned_to: "self",
    });
    const msg = r.status === "error" ? r.message : "";
    check("9:24:55 reproduzido: create_contact com o telefone do candidato é RECUSADO", r.status === "error" && (r as { code?: string }).code === "data_from_other_contact", r);
    check("…e não chega a criar nada", posts(chamadas, "/contacts/").length === 0);
    check("…a mensagem aponta o telefone que a Ana digitou", msg.includes(TEL_FILIPE), msg);
    check("…e diz de quem é o número usado", msg.includes("Filipe Candidato Um"), msg);
    check("…retryable (o modelo corrige, não vira sinal de erro)", r.status === "error" && r.retryable === true);
  }
  {
    const { ctx, chamadas } = makeCtx({ donos });
    const r = await createContact.handler(ctx, { first_name: "Filipe", last_name: "Sonoplasta", phone: TEL_FILIPE, assigned_to: "self" });
    const p = posts(chamadas, "/contacts/")[0];
    check("com o telefone digitado: cria, com o telefone certo e a Ana de dona", r.status === "ok" && p?.body?.phone === TEL_FILIPE && p?.body?.assignedTo === ANA_USER, p?.body);
    check("telefone digitado não gasta consulta extra ao CRM", !chamadas.some((x) => x.path === "/contacts/search/duplicate"));
  }
  {
    const { ctx, chamadas } = makeCtx({ donos, repMessage: "Cria o Filipe Sonoplasta pra mim, o número tá no cartão que mandei" });
    const r = await createContact.handler(ctx, { first_name: "Filipe", phone: TEL_CANDIDATO });
    check("rep não digitou telefone (ex: cartão em foto): a regra não entra", r.status === "ok" && !chamadas.some((x) => x.path === "/contacts/search/duplicate"), r);
  }
  {
    const { ctx } = makeCtx({ donos: {} });
    const r = await createContact.handler(ctx, { first_name: "Filipe", phone: "+13055550199" });
    check("telefone diferente do digitado mas sem dono no CRM (lido de imagem): cria", r.status === "ok", r);
  }
  {
    const { ctx } = makeCtx({ donos, dupFalha: true });
    const r = await createContact.handler(ctx, { first_name: "Filipe", phone: TEL_CANDIDATO });
    check("consulta ao CRM falhou: segue o fluxo de antes (fail-open)", r.status === "ok", r);
  }
  {
    const { ctx, chamadas } = makeCtx({ donos, repMessage: "o número dele é 843-555-0137" });
    const r = await createContact.handler(ctx, { first_name: "Filipe", phone: "+1 (843) 555-0137" });
    check("formato diferente do mesmo número (sem +1, com hífen) conta como digitado", r.status === "ok" && !chamadas.some((x) => x.path === "/contacts/search/duplicate"), r);
  }
  {
    const { ctx } = makeCtx({
      donos: { "cand2@exemplo.com": { id: "CandidatoDois0000001", firstName: "Filipe", lastName: "Candidato Dois" } },
      repMessage: "o email dele é filipe.sonoplasta@exemplo.com",
    });
    const r = await conferirDadoDigitado(ctx, { email: "cand2@exemplo.com" });
    check("e-mail: o de outro contato também é recusado quando o rep digitou outro", r?.status === "error" && r.message.includes("filipe.sonoplasta@exemplo.com"), r);
  }
  check("extrai o telefone da fala real (áudio + número)", extractTypedPhones(FALA_ANA).join() === "+18435550137", extractTypedPhones(FALA_ANA));
  check("telefone digitado sem '+' sai só com dígitos", extractTypedPhones("liga 843 555 0137").join() === "8435550137", extractTypedPhones("liga 843 555 0137"));
  check("data, hora e valor não viram telefone", extractTypedPhones("terça 27/10/2026 às 17:30, apólice de $250.000, 2026-10-27").length === 0);
  check(
    "eco de menu (telefone de outra pessoa na opção) não conta como digitado",
    // O eco de menu separa com o caractere U+2014 (formato externo lido pelo stripOptionEcho).
    extractTypedPhones('Sim \u2014 (resposta à pergunta: "Qual?") [opção escolhida na lista: "fulana" (+1 737-555-0156)]').length === 0,
  );
  check("e-mail extraído em minúsculas", extractTypedEmails("manda pra Filipe@Exemplo.com").join() === "filipe@exemplo.com");
  check("mesmoTelefone: +1 e formatação não importam", mesmoTelefone("(843) 555-0137", "+18435550137"));
  check("mesmoTelefone: números diferentes", !mesmoTelefone(TEL_FILIPE, TEL_CANDIDATO));

  // -------------------------------------------------------------------------
  console.log("\n3. Causa raiz: o 'assunto pendente' pegava o telefone do 1º candidato");
  // -------------------------------------------------------------------------
  {
    const s = extractPendingSubject([{ name: "search_contacts", input: { query: "Filipe Sonoplasta" }, result_preview: PREVIEW_BUSCA_BAIXA }]);
    check("busca de confiança baixa segue virando assunto (nome)", s?.name === "Filipe Sonoplasta", s);
    check("…mas SEM o telefone do candidato (antes: +19545550111)", !s?.phone, s);
  }
  {
    const s = extractPendingSubject([{ name: "search_contacts", input: { query: "+1 (843) 555-0137" }, result_preview: '{"status":"not_found","message":"Nenhum contato encontrado pra \\"+1 (843) 555-0137\\" (tentei variações de nome e de telefone)."}' }]);
    check("busca POR telefone: o telefone buscado continua valendo", !!s?.phone && s.phone.replace(/\D/g, "").endsWith("8435550137"), s);
  }
  {
    const s = extractPendingSubject([
      {
        name: "create_contact",
        input: { first_name: "Filipe", last_name: "Sonoplasta", phone: TEL_CANDIDATO },
        result_preview: '{"status":"error","message":"…","retryable":true,"code":"data_from_other_contact"}',
      },
    ]);
    check("criação recusada pelo H108 não leva o telefone recusado adiante", s?.name === "Filipe Sonoplasta" && !s?.phone, s);
  }
  {
    const s = extractPendingSubject([
      { name: "create_contact", input: { first_name: "Paulo", last_name: "Abreu", phone: "+1 561-555-0185" }, result_preview: '{"ok":true}' },
    ]);
    check("criação normal continua levando o telefone (H59 intacto)", s?.phone === "+1 561-555-0185", s);
  }

  // -------------------------------------------------------------------------
  console.log("\n4. Duração vem do calendário");
  // -------------------------------------------------------------------------
  const cal60 = { durationOptions: [{ duration: 60, durationUnit: "mins", isDefault: true }], slotDuration: 60, slotDurationUnit: "mins" };
  {
    const d = ajustarDuracaoAoCalendario(cal60, "2026-10-27T17:30:00-04:00", "2026-10-27T18:00:00-04:00");
    check("CASO ANA: 30 min num calendário de 60 vira 17:30 a 18:30", d.ajustado && d.usadoMin === 60 && d.pedidoMin === 30 && d.endIso === "2026-10-27T22:30:00.000Z", d);
  }
  {
    const d = ajustarDuracaoAoCalendario(cal60, "2026-10-27T17:00:00-04:00", "2026-10-27T18:00:00-04:00");
    check("duração aceita não muda", !d.ajustado && d.endIso === "2026-10-27T18:00:00-04:00", d);
  }
  {
    const d = ajustarDuracaoAoCalendario({ slotDuration: 30 }, "2026-10-27T17:00:00-04:00", "2026-10-27T18:30:00-04:00");
    check("calendário sem durationOptions: fica como o modelo mandou", !d.ajustado && d.usadoMin === 90, d);
  }
  {
    const d = ajustarDuracaoAoCalendario(
      { durationOptions: [{ duration: 30, durationUnit: "mins" }, { duration: 60, durationUnit: "mins", isDefault: true }] },
      "2026-10-27T17:00:00-04:00",
      "2026-10-27T17:45:00-04:00",
    );
    check("45 min com opções 30/60: usa a padrão (60)", d.ajustado && d.usadoMin === 60, d);
  }
  {
    const d = ajustarDuracaoAoCalendario(
      { durationOptions: [{ duration: 30, durationUnit: "mins" }, { duration: 60, durationUnit: "mins", isDefault: true }] },
      "2026-10-27T17:00:00-04:00",
      "2026-10-27T17:30:00-04:00",
    );
    check("30 min com opções 30/60: mantém 30", !d.ajustado && d.usadoMin === 30, d);
  }
  {
    const d = ajustarDuracaoAoCalendario({ durationOptions: [{ duration: 1, durationUnit: "hours", isDefault: true }] }, "2026-10-27T17:00:00-04:00", "2026-10-27T17:30:00-04:00");
    check("opção em horas (1 hour) vira 60 min", d.ajustado && d.usadoMin === 60, d);
  }
  check("sem calendário (leitura falhou): nada muda", !ajustarDuracaoAoCalendario(null, "2026-10-27T17:00:00Z", "2026-10-27T17:30:00Z").ajustado);

  // -------------------------------------------------------------------------
  console.log("\n5. Calendário vai por ID (o bot passou o nome às 9:27:47)");
  // -------------------------------------------------------------------------
  {
    const { ctx, chamadas } = makeCtx({ repMessage: null, durationOptions: cal60.durationOptions });
    const r = await createAppointment.handler(ctx, {
      calendar_id: "Consultoria de Seguros (Produtos)",
      contact_id: "ContatoFilipe0000001",
      start_time: "2026-10-27T17:30:00-04:00",
      end_time: "2026-10-27T18:00:00-04:00",
    });
    const p = posts(chamadas, "/calendars/events/appointments")[0];
    const data = (r.status === "ok" ? r.data : {}) as Record<string, unknown>;
    check("CASO ANA ponta a ponta: nome do calendário resolvido pro ID", r.status === "ok" && p?.body?.calendarId === CAL_ID, r);
    check("…e a reunião vai com 60 min (fim 18:30)", p?.body?.endTime === "2026-10-27T22:30:00.000Z", p?.body);
    check("…o retorno avisa a duração ajustada", data.duration_min === 60 && !!data.duration_adjusted && typeof data.note === "string", data);
    check("…e diz de onde o calendário foi resolvido", data.calendar_resolved_from === "Consultoria de Seguros (Produtos)", data);
    check("…lendo a configuração do calendário uma vez só", chamadas.filter((x) => x.path === `/calendars/${CAL_ID}`).length === 1);
  }
  {
    const { ctx } = makeCtx({});
    for (const [entrada, esperado] of [
      ["consultoria de seguros (produtos)", CAL_ID],
      ["Consultoria de Seguros Produtos", CAL_ID],
      ["consultoria-seguros", CAL_ID],
      ["revisao anual de apolice", CAL_REVISAO],
      ["default", CAL_ID],
      [CAL_REVISAO, CAL_REVISAO],
    ] as const) {
      const r = await resolverCalendarioId(ctx, entrada);
      check(`resolve "${entrada}"`, r.ok && r.id === esperado, r);
    }
  }
  {
    const { ctx, chamadas } = makeCtx({});
    const r = await createAppointment.handler(ctx, {
      calendar_id: "your_calendar_id",
      contact_id: "ContatoFilipe0000001",
      start_time: "2026-10-27T17:00:00-04:00",
      end_time: "2026-10-27T18:00:00-04:00",
    });
    const msg = r.status === "error" ? r.message : "";
    check("placeholder inventado não vira calendário nenhum", r.status === "error" && posts(chamadas, "/calendars/events/appointments").length === 0, r);
    check("…o erro lista os calendários com ID", msg.includes(CAL_ID) && msg.includes("Revisão Anual de Apólice"), msg);
  }
  {
    const { ctx } = makeCtx({
      pref: {},
      calendarios: [
        { id: CAL_ID, name: "Consultoria", teamMembers: [{ userId: ANA_USER }] },
        { id: CAL_REVISAO, name: "Revisão", teamMembers: [{ userId: ANA_USER }] },
      ],
    });
    const r = await resolverCalendarioId(ctx, "default");
    check("'default' sem padrão salvo e com 2 calendários: não chuta", !r.ok, r);
  }
  {
    const { ctx } = makeCtx({ pref: {}, calendarios: [{ id: CAL_ID, name: "Única", teamMembers: [{ userId: ANA_USER }] }] });
    const r = await resolverCalendarioId(ctx, "default");
    check("'default' com um único calendário utilizável: usa ele", r.ok && r.id === CAL_ID, r);
  }
  {
    const e = validateGhlId("Consultoria de Seguros (Produtos)", "calendar");
    check("dica de id inválido de calendário manda usar list_calendars", e?.status === "error" && e.message.includes("list_calendars") && !e.message.includes("search_contacts"), e);
    const c = validateGhlId("Filipe", "contact");
    check("…e a de contato continua mandando search_contacts", c?.status === "error" && c.message.includes("search_contacts"), c);
  }

  console.log(`\n${pass}/${pass + fail} passaram${fail ? `, ${fail} FALHARAM` : ""}\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error("teste quebrou:", e);
  process.exit(1);
});
