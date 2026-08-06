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
  isMergeFieldNaoResolvido,
} from "../src/lib/account-assistant/webhook-commands/parse";
import {
  repAtendeLocation,
  verificarSegredo,
} from "../src/lib/account-assistant/webhook-commands/authorize";
import { fingerprintComando } from "../src/lib/account-assistant/webhook-commands/audit";

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

console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass}/${pass + fail} passaram`);
process.exit(fail === 0 ? 0 : 1);
