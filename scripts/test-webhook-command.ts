/**
 * Testes dos comandos via webhook do Spark Leads (H71).
 *
 * Puro, sem banco: só as funções que decidem. O que se protege aqui:
 *
 *  1. O DESTINO. O payload de automação do Spark Leads já traz `phone` = o
 *     telefone do LEAD. Se o parser aceitasse `phone` como destino, o aviso do
 *     corretor iria pro cliente dele. É o erro mais fácil de reintroduzir por
 *     "simpatia" com o payload — a seção 1 existe pra travar isso.
 *  2. A REGRA DE ESCOPO que o Pedro pediu: comando de uma conta só pode avisar
 *     corretor DAQUELA conta (seção 5). Sem esse teste, a feature não está
 *     validada.
 *  3. Merge field não resolvido (`{{contact.phone}}` literal) vale como
 *     AUSÊNCIA — mesma classe do falso-positivo do F52.
 *
 * Rodar: npx tsx scripts/test-webhook-command.ts
 */
import {
  parseWebhookCommand,
  extrairLocationId,
  extrairSegredo,
  isMergeFieldNaoResolvido,
} from "../src/lib/account-assistant/webhook-commands/parse";
import {
  repAtendeLocation,
  verificarSegredo,
  candidatosDeTelefone,
} from "../src/lib/account-assistant/webhook-commands/authorize";
import { fingerprintComando } from "../src/lib/account-assistant/webhook-commands/audit";
import { safeToolNames } from "../src/lib/account-assistant/webhook-commands/run";
import { TOOL_REGISTRY } from "../src/lib/account-assistant/tools";

let pass = 0,
  fail = 0;
function ok(nome: string, cond: boolean, detalhe?: string) {
  if (cond) {
    pass++;
    console.log(`  ✅ ${nome}`);
  } else {
    fail++;
    console.error(`  ❌ ${nome}${detalhe ? ` — ${detalhe}` : ""}`);
  }
}

/** Falha o teste se o parse não deu certo, e estreita o tipo. */
function esperaOk(nome: string, body: unknown) {
  const r = parseWebhookCommand(body);
  if (!r.ok) {
    fail++;
    console.error(`  ❌ ${nome} — esperava ok, veio ${r.reason}: ${r.detail}`);
    return null;
  }
  return r.command;
}

function esperaErro(nome: string, body: unknown, reason: string, detalhePattern?: RegExp) {
  const r = parseWebhookCommand(body);
  if (r.ok) {
    fail++;
    console.error(`  ❌ ${nome} — esperava erro "${reason}", mas o parse passou`);
    return;
  }
  if (r.reason !== reason) {
    fail++;
    console.error(`  ❌ ${nome} — esperava "${reason}", veio "${r.reason}"`);
    return;
  }
  if (detalhePattern && !detalhePattern.test(r.detail)) {
    fail++;
    console.error(`  ❌ ${nome} — detalhe não menciona o esperado: "${r.detail}"`);
    return;
  }
  pass++;
  console.log(`  ✅ ${nome}`);
}

const LOC = "JhuP409NhSBHmYW4RzNi";
const CORRETOR = "+17867717077";
const LEAD = "+15615551234";

// ── 1. O destino NUNCA é o telefone do lead ─────────────────────────────────
console.log("\n1. destino — `phone` do payload é o LEAD e não pode virar destino");

esperaErro(
  "payload de automação com `phone` do lead e sem send_to → erro de destino",
  { location_id: LOC, message_type: "notification", message: "Fulano pediu retorno.", phone: LEAD },
  "destino_ausente",
  /phone.*LEAD|LEAD/i,
);

esperaErro(
  "`contact_phone` também não conta como destino",
  {
    location_id: LOC,
    message_type: "notification",
    message: "Aviso",
    contact_phone: LEAD,
    contact: { phone: LEAD },
  },
  "destino_ausente",
);

{
  const c = esperaOk("com send_to explícito, o phone do lead é ignorado", {
    location_id: LOC,
    message_type: "notification",
    message: "Fulano pediu retorno.",
    phone: LEAD,
    send_to: CORRETOR,
  });
  if (c) ok(`  destino é o corretor (${CORRETOR})`, c.sendTo === CORRETOR, `veio "${c?.sendTo}"`);
}

esperaErro(
  "send_to com merge field não resolvido → erro que EXPLICA o merge field",
  {
    location_id: LOC,
    message_type: "notification",
    message: "Aviso",
    send_to: "{{contact.phone}}",
  },
  "destino_ausente",
  /merge field/i,
);

ok("isMergeFieldNaoResolvido pega `{{...}}`", isMergeFieldNaoResolvido("{{contact.phone}}"));
ok("…e não acusa número normal", !isMergeFieldNaoResolvido(CORRETOR));

// ── 2. Location — três formatos, porque o Spark Leads varia ─────────────────
console.log("\n2. location_id — raiz, objeto aninhado e customData");

ok("raiz: location_id", extrairLocationId({ location_id: LOC }) === LOC);
ok("aninhado: location.id (webhook nativo)", extrairLocationId({ location: { id: LOC } }) === LOC);
ok("customData: location_id", extrairLocationId({ customData: { location_id: LOC } }) === LOC);
ok("camelCase: locationId", extrairLocationId({ locationId: LOC }) === LOC);
ok("merge field não resolvido não vira location", extrairLocationId({ location_id: "{{location.id}}" }) === null);
ok("sem nada → null", extrairLocationId({ contact_id: "abc" }) === null);

esperaErro(
  "payload sem location → erro que ensina o conserto",
  { message_type: "notification", message: "oi", send_to: CORRETOR },
  "location_ausente",
  /location_id|location\.id/,
);
esperaErro("corpo vazio", {}, "payload_vazio");
esperaErro("corpo que não é objeto", "isso não é json de objeto", "payload_vazio");

{
  const c = esperaOk("campos dentro de customData funcionam inteiros", {
    location: { id: LOC, name: "Fabiana Leme" },
    customData: { message_type: "aviso", send_to: CORRETOR, message: "Chegou lead novo." },
  });
  if (c) {
    ok("  location veio do objeto aninhado", c.locationId === LOC);
    ok("  tipo veio do customData", c.kind === "notification");
    ok("  destino veio do customData", c.sendTo === CORRETOR);
  }
}

// ── 3. Vocabulário do tipo — humano montando automação escreve como quer ────
console.log("\n3. sinônimos do tipo (e o que NÃO é sinônimo)");

const tipoVira = (valor: string, esperado: "notification" | "prompt") => {
  const c = parseWebhookCommand({
    location_id: LOC,
    message_type: valor,
    message: "texto",
    prompt: "texto",
    send_to: CORRETOR,
  });
  ok(`"${valor}" → ${esperado}`, c.ok && c.command.kind === esperado, c.ok ? `veio ${c.command.kind}` : c.reason);
};

tipoVira("notification", "notification");
tipoVira("NOTIFICATION", "notification");
tipoVira("aviso", "notification");
tipoVira("notificação", "notification"); // com acento
tipoVira("Notificacao", "notification");
tipoVira("alerta", "notification");
tipoVira("prompt", "prompt");
tipoVira("comando", "prompt");
tipoVira("instrução", "prompt");
tipoVira("AI", "prompt");

esperaErro(
  "tipo desconhecido não vira nada por adivinhação",
  { location_id: LOC, message_type: "urgente", message: "oi", send_to: CORRETOR },
  "tipo_desconhecido",
  /notification.*prompt|prompt.*notification/s,
);
esperaErro(
  "sem tipo → erro que diz o campo e os dois valores",
  { location_id: LOC, message: "oi", send_to: CORRETOR },
  "tipo_ausente",
  /message_type/,
);
{
  // `type` alheio (payload de automação usa `type` pra outra coisa) não pode
  // virar comando por acidente — cai no erro de tipo, não num envio errado.
  const r = parseWebhookCommand({
    location_id: LOC,
    type: "ContactCreate",
    message: "oi",
    send_to: CORRETOR,
  });
  ok("`type` de outro propósito não vira comando", !r.ok, r.ok ? `virou ${r.command.kind}` : undefined);
}

// ── 4. Mensagem vs prompt ───────────────────────────────────────────────────
console.log("\n4. corpo do comando");

{
  const c = esperaOk("modo prompt: `prompt` vence `message`", {
    location_id: LOC,
    message_type: "prompt",
    prompt: "Resume esse lead.",
    message: "texto de aviso",
    send_to: CORRETOR,
  });
  if (c) ok("  a instrução é o prompt", c.message === "Resume esse lead.", `veio "${c?.message}"`);
}
{
  const c = esperaOk("modo prompt aceita só `message` (fallback)", {
    location_id: LOC,
    message_type: "prompt",
    message: "Resume esse lead.",
    send_to: CORRETOR,
  });
  if (c) ok("  usa a message como instrução", c.message === "Resume esse lead.");
}
{
  // O contrário NÃO vale: aviso não pode pescar um `prompt` solto e mandar cru.
  const r = parseWebhookCommand({
    location_id: LOC,
    message_type: "notification",
    prompt: "Resume esse lead.",
    send_to: CORRETOR,
  });
  ok("modo notification NÃO pesca um `prompt` solto", !r.ok && r.reason === "mensagem_ausente");
}
esperaErro(
  "message vazia → erro que cita o merge field como suspeito",
  { location_id: LOC, message_type: "notification", message: "   ", send_to: CORRETOR },
  "mensagem_ausente",
  /merge field/i,
);

{
  const c = esperaOk("contato e request_id entram quando existem", {
    location_id: LOC,
    message_type: "prompt",
    prompt: "Resume.",
    send_to: CORRETOR,
    contact_id: "ct_123",
    first_name: "Fabiana",
    last_name: "Leme",
    request_id: "evt_987",
  });
  if (c) {
    ok("  contact_id", c.contactId === "ct_123");
    ok("  nome montado de first+last", c.contactName === "Fabiana Leme", `veio "${c?.contactName}"`);
    ok("  request_id (idempotência)", c.requestId === "evt_987");
  }
}

// ── 5. A regra do Pedro: só corretor DAQUELA conta ──────────────────────────
console.log("\n5. repAtendeLocation — trava de escopo");

const OUTRA = "outra_location_9999";
ok(
  "match por active_location_id",
  repAtendeLocation({ active_location_id: LOC, ghl_users: [] }, LOC),
);
ok(
  "match por vínculo em ghl_users[]",
  repAtendeLocation(
    {
      active_location_id: OUTRA,
      ghl_users: [
        { location_id: "xxx", ghl_user_id: "u1", location_name: null, role: null },
        { location_id: LOC, ghl_user_id: "u2", location_name: null, role: null },
      ],
    },
    LOC,
  ),
);
ok(
  "NÃO-MATCH: corretor de outra conta é barrado (regra pedida pelo Pedro)",
  !repAtendeLocation(
    {
      active_location_id: OUTRA,
      ghl_users: [{ location_id: OUTRA, ghl_user_id: "u1", location_name: null, role: null }],
    },
    LOC,
  ),
);
ok(
  "rep sem vínculo nenhum é barrado",
  !repAtendeLocation({ active_location_id: null, ghl_users: [] }, LOC),
);
ok(
  "ghl_users corrompido (não-array) não explode nem libera",
  !repAtendeLocation(
    { active_location_id: null, ghl_users: null as unknown as [] },
    LOC,
  ),
);

// ── 6. Segredo compartilhado ────────────────────────────────────────────────
console.log("\n6. verificarSegredo");

delete process.env.SPARKBOT_COMMAND_SECRET;
ok("sem env configurada → passa (travas 2 e 3 seguem valendo)", verificarSegredo(null, null).ok);

process.env.SPARKBOT_COMMAND_SECRET = "s3gr3d0-do-pedro";
ok("com env e sem segredo → barra", !verificarSegredo(null, null).ok);
ok("segredo errado → barra", !verificarSegredo("errado", null).ok);
ok("prefixo certo mas curto → barra", !verificarSegredo("s3gr3d0", null).ok);
ok("segredo certo no header → passa", verificarSegredo("s3gr3d0-do-pedro", null).ok);
ok("segredo certo no body → passa", verificarSegredo(null, "s3gr3d0-do-pedro").ok);
// Header preenchido tem precedência: se ele veio errado, o body certo NÃO
// salva. Fail-closed de propósito — dois segredos discordando é sinal de
// automação mal montada, não de tentativa legítima.
ok("header errado + body certo → barra (header tem precedência)", !verificarSegredo("errado", "s3gr3d0-do-pedro").ok);
{
  const r = verificarSegredo(null, null);
  ok("o erro de segredo ausente ensina onde por", !r.ok && /x-spark-secret/.test(r.detail));
}
delete process.env.SPARKBOT_COMMAND_SECRET;

// `extrairSegredo` existe pra a rota conferir o segredo ANTES do parse — o
// endpoint é público, e conferir depois deixava um `POST {}` anônimo gravar
// linha de auditoria. Ele tem que achar o segredo mesmo num payload que o
// parse REJEITARIA (sem tipo, sem destino, sem mensagem): é exatamente esse o
// caso em que a ordem importa.
ok("extrairSegredo: raiz", extrairSegredo({ secret: "abc" }) === "abc");
ok("extrairSegredo: customData", extrairSegredo({ customData: { secret: "abc" } }) === "abc");
ok("extrairSegredo: apelido `token`", extrairSegredo({ token: "abc" }) === "abc");
ok("extrairSegredo: camelCase", extrairSegredo({ sparkSecret: "abc" }) === "abc");
ok(
  "extrairSegredo acha em payload que o parse rejeitaria (sem tipo/destino/msg)",
  extrairSegredo({ location_id: LOC, secret: "abc" }) === "abc",
);
ok("extrairSegredo: payload vazio → null", extrairSegredo({}) === null);
ok(
  "extrairSegredo: merge field não resolvido não vira segredo",
  extrairSegredo({ secret: "{{custom.secret}}" }) === null,
);

// ── 7. Impressão digital (idempotência sem request_id) ──────────────────────
console.log("\n7. fingerprintComando");

const base = {
  locationId: LOC,
  kind: "notification" as const,
  message: "Fulano pediu retorno.",
  sendTo: CORRETOR,
  contactId: null,
  contactName: null,
  requestId: null,
  secret: null,
};
ok("mesmo comando → mesma digital", fingerprintComando(base) === fingerprintComando({ ...base }));
ok("texto diferente → digital diferente", fingerprintComando(base) !== fingerprintComando({ ...base, message: "outro" }));
ok("destino diferente → digital diferente", fingerprintComando(base) !== fingerprintComando({ ...base, sendTo: "+15550001111" }));
ok("conta diferente → digital diferente", fingerprintComando(base) !== fingerprintComando({ ...base, locationId: OUTRA }));
ok("modo diferente → digital diferente", fingerprintComando(base) !== fingerprintComando({ ...base, kind: "prompt" }));
ok("é hex de sha256", /^[0-9a-f]{64}$/.test(fingerprintComando(base)));

// O caso que a feature existe pra atender: workflow "novo lead" com texto FIXO
// e contato variável. Sem contactId na digital, o 2º lead em menos de 60s
// viraria "duplicata" e o corretor nunca ficaria sabendo dele.
const prompt = { ...base, kind: "prompt" as const, message: "Resume esse lead e diz o próximo passo." };
ok(
  "MESMO prompt, contatos diferentes → digitais diferentes",
  fingerprintComando({ ...prompt, contactId: "lead_maria" }) !==
    fingerprintComando({ ...prompt, contactId: "lead_joao" }),
);
ok(
  "mesmo contato, mesmo prompt → mesma digital (reentrega É duplicata)",
  fingerprintComando({ ...prompt, contactId: "lead_maria" }) ===
    fingerprintComando({ ...prompt, contactId: "lead_maria" }),
);
ok(
  "sem contato de um lado e com do outro → digitais diferentes",
  fingerprintComando(prompt) !== fingerprintComando({ ...prompt, contactId: "lead_maria" }),
);

// ── 8. Tools do modo prompt: só CONSULTA ────────────────────────────────────
// `risk === "safe"` no registry quer dizer "não pede confirmação", NÃO quer
// dizer "só lê". Oito tools safe escrevem — inclusive `schedule_reminder`, que
// agenda um WhatsApp futuro. Como o comando roda sem humano no circuito, uma
// automação mal configurada (ou um texto malicioso no campo `message`, que
// vira instrução pro LLM) não pode alcançá-las.
console.log("\n8. safeToolNames — o modo prompt não pode escrever");

const liberadas = safeToolNames();
const ESCREVEM = [
  "schedule_reminder",
  "cancel_reminder",
  "set_rep_alias",
  "forget_rep_alias",
  "set_rep_preferred_name",
  "set_scheduling_pref",
  "set_verbosity_preference",
  "confirm_rep_timezone",
  "report_missed_capability",
];
for (const t of ESCREVEM) {
  ok(`\`${t}\` NÃO está liberada`, !liberadas.includes(t));
}
for (const t of ["get_contact", "search_contacts", "list_appointments", "get_conversation_history"]) {
  ok(`\`${t}\` está liberada (é consulta)`, liberadas.includes(t));
}
ok(
  "nenhuma tool de risco medium/high entra",
  Object.values(TOOL_REGISTRY)
    .filter((e) => e.def.risk !== "safe")
    .every((e) => !liberadas.includes(e.def.name)),
);
ok(
  "toda liberada começa por verbo de leitura",
  liberadas.every((n) =>
    ["get_", "list_", "search_", "count_", "describe_", "query_", "analyze_", "recap_", "preview_"].some(
      (v) => n.startsWith(v),
    ),
  ),
  liberadas.filter((n) => !/^(get|list|search|count|describe|query|analyze|recap|preview)_/.test(n)).join(", "),
);
// `present_options` abre menu numerado e espera o rep escolher. Num comando
// disparado por automação não há ninguém pra escolher — o modelo abriria um
// menu que morre sozinho.
ok("`present_options` NÃO está liberada", !liberadas.includes("present_options"));
ok("a lista não ficou vazia por acidente", liberadas.length >= 30, `${liberadas.length} tools`);

// ── 9. Precedência de escopo: o customData ganha da raiz ────────────────────
// A raiz do payload é montada pela PLATAFORMA e usa nomes genéricos pras
// coisas dela — `message`, `body` e `text` na raiz costumam ser o texto que o
// LEAD escreveu. Se a raiz ganhasse, o SparkBot mandaria o texto do lead pro
// corretor; no modo prompt, esse texto viraria INSTRUÇÃO pro LLM. Mesma
// classe do bug do `phone`, e mais perigosa.
console.log("\n9. escopo — o que o humano configurou ganha do que a plataforma mandou");

{
  const c = esperaOk("customData.message vence message da raiz (texto do lead)", {
    location: { id: LOC },
    // como a plataforma manda:
    message: "oi, quero saber sobre o seguro de vida",
    body: "oi, quero saber sobre o seguro de vida",
    type: "SMS",
    phone: LEAD,
    // como o agente configurou:
    customData: {
      message_type: "notification",
      send_to: CORRETOR,
      message: "Fulano pediu retorno pelo formulário.",
    },
  });
  if (c) {
    ok("  o texto é o do AGENTE", c.message === "Fulano pediu retorno pelo formulário.", `veio "${c?.message}"`);
    ok("  o destino é o corretor", c.sendTo === CORRETOR);
    ok("  o tipo é o do customData, não o `type: SMS` da raiz", c.kind === "notification");
  }
}
{
  const c = esperaOk("customData.message_type vence type/messageType da raiz", {
    location_id: LOC,
    messageType: "prompt",
    customData: { message_type: "notification", send_to: CORRETOR, message: "Aviso." },
  });
  if (c) ok("  vale o customData", c.kind === "notification", `veio ${c?.kind}`);
}
{
  // `text`/`body`/`content` na RAIZ não podem virar o comando de jeito nenhum.
  const r = parseWebhookCommand({
    location_id: LOC,
    customData: { message_type: "notification", send_to: CORRETOR },
    text: "texto do lead",
    body: "texto do lead",
    content: "texto do lead",
  });
  ok(
    "`text`/`body`/`content` na raiz NÃO viram a mensagem",
    !r.ok && r.reason === "mensagem_ausente",
    r.ok ? `virou "${r.command.message}"` : r.reason,
  );
}
ok(
  "…mas dentro do customData eles valem",
  (() => {
    const r = parseWebhookCommand({
      location_id: LOC,
      customData: { message_type: "notification", send_to: CORRETOR, text: "Aviso pelo campo text." },
    });
    return r.ok && r.command.message === "Aviso pelo campo text.";
  })(),
);
{
  const c = esperaOk("`to` na raiz não é destino, mas no customData é", {
    location_id: LOC,
    to: "+15550009999",
    customData: { message_type: "notification", message: "Aviso.", to: CORRETOR },
  });
  if (c) ok("  destino veio do customData", c.sendTo === CORRETOR, `veio "${c?.sendTo}"`);
}
ok(
  "`type: \"message\"` da plataforma NÃO vira comando de aviso",
  (() => {
    const r = parseWebhookCommand({
      location_id: LOC,
      customData: { type: "message", send_to: CORRETOR, message: "x" },
    });
    return !r.ok && r.reason === "tipo_desconhecido";
  })(),
);
{
  const c = esperaOk("apelidos sem colisão (sparkbot_message) funcionam na raiz", {
    location_id: LOC,
    message_type: "notification",
    send_to: CORRETOR,
    message: "texto do lead",
    sparkbot_message: "Aviso de verdade.",
  });
  if (c) ok("  o apelido explícito ganha", c.message === "Aviso de verdade.", `veio "${c?.message}"`);
}

// ── 10. Merge field quebrado no destino ABORTA (não cai pro próximo apelido) ─
console.log("\n10. merge field no destino não cai pra outro campo");
esperaErro(
  "send_to quebrado não vira o `to` que sobrou",
  {
    location_id: LOC,
    customData: {
      message_type: "notification",
      message: "Aviso",
      send_to: "{{contact.custom.rep_phone}}",
      to: "+15550009999",
    },
  },
  "destino_ausente",
  /merge field/i,
);

// ── 11. Formato do telefone que um humano digita no custom data ─────────────
// O `generatePhoneCandidates` sozinho transforma "17867717077" (EUA, com DDI,
// sem o "+") em +5517867717077 e +117867717077 — nenhum dos dois existe. O
// corretor certo nunca era achado e a resposta ainda culpava a location.
console.log("\n11. candidatosDeTelefone");

const temE164 = (bruto: string, esperado: string) =>
  ok(`"${bruto}" gera ${esperado}`, candidatosDeTelefone(bruto).includes(esperado));

temE164("+17867717077", "+17867717077");
temE164("17867717077", "+17867717077"); // o caso que quebrava
temE164("7867717077", "+17867717077");
temE164("(786) 771-7077", "+17867717077");
temE164("786-771-7077", "+17867717077");
temE164("+1 786 771 7077", "+17867717077");
temE164("5531999232306", "+5531999232306");
ok("lixo não vira candidato", candidatosDeTelefone("liga pra mim").length === 0 ||
  candidatosDeTelefone("liga pra mim").every((c) => c.replace(/\D/g, "").length >= 8));
ok("sem duplicata na lista", (() => {
  const c = candidatosDeTelefone("7867717077");
  return new Set(c).size === c.length;
})());

console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass}/${pass + fail} passaram`);
process.exit(fail === 0 ? 0 : 1);
