/**
 * Testes do transporte SparkZap (H57, 2026-07-28) — o SparkBot falando pela
 * engine própria da Spark em vez do Stevo.
 *
 * Cobre as 3 peças novas SEM tocar a rede (fetch é stubado):
 *   1. `pickWaTransport` — a chave + allowlist de rollout por rep. Um erro aqui
 *      cala um rep, então cada caminho tem caso.
 *   2. `sparkzap-send` — o contrato da porta `/api/ingest/wa/send` do Spark OS:
 *      splitter `---`, dedupeKey por bolha, TRUNCAMENTO client-side (o rich.ts
 *      do OS REJEITA label >20 em vez de truncar — sem truncar aqui, um 422
 *      viraria fallback de texto à toa), payload de botão/lista e o mapa de
 *      resposta ({ok,outboxId} = aceito na fila; duplicate = sucesso).
 *   3. `sparkzap-parser` — os DOIS envelopes, o LID não resolvido (que seria
 *      descarte silencioso) e o `base64` preservado (áudio/PDF do rep).
 *
 * Rodar: npx tsx scripts/test-sparkzap-transport.ts
 */
import { pickWaTransport, sparkZapAllowlist } from "../src/lib/account-assistant/webhook/wa-transport";
import { parseSparkZapWebhook } from "../src/lib/account-assistant/webhook/sparkzap-parser";
import {
  sendSparkZapText,
  sendSparkZapButton,
  sendSparkZapList,
} from "../src/lib/account-assistant/webhook/sparkzap-send";

let pass = 0,
  fail = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.error(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function withEnv(env: Record<string, string | undefined>, fn: () => void | Promise<void>) {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const restore = () => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  const out = fn();
  if (out instanceof Promise) return out.finally(restore);
  restore();
  return Promise.resolve();
}

async function main() {
  // -------------------------------------------------------------------------
  // 1. Chave de transporte
  // -------------------------------------------------------------------------
  console.log("\npickWaTransport — a chave do rollout");

  await withEnv({ SPARKBOT_WA_TRANSPORT: undefined, SPARKZAP_REPS: undefined }, () => {
    check("default é stevo (deployar não muda nada)", pickWaTransport("+17867717077") === "stevo");
  });

  await withEnv({ SPARKBOT_WA_TRANSPORT: "sparkzap", SPARKZAP_REPS: undefined }, () => {
    check("sparkzap sem allowlist = todos", pickWaTransport("+17867717077") === "sparkzap");
    check("sparkzap sem allowlist vale sem telefone", pickWaTransport() === "sparkzap");
  });

  await withEnv({ SPARKBOT_WA_TRANSPORT: "sparkzap", SPARKZAP_REPS: "+17867717077" }, () => {
    check("rep na allowlist → sparkzap", pickWaTransport("+17867717077") === "sparkzap");
    check("rep FORA da allowlist → stevo", pickWaTransport("+15551234567") === "stevo");
    check("formatação diferente casa", pickWaTransport("1 (786) 771-7077") === "sparkzap");
    check("sem DDI na msg casa por sufixo", pickWaTransport("7867717077") === "sparkzap");
    check("sem telefone → stevo (não afirma rollout)", pickWaTransport() === "stevo");
    check("allowlist parseada", sparkZapAllowlist().length === 1);
  });

  await withEnv(
    { SPARKBOT_WA_TRANSPORT: "sparkzap", SPARKZAP_REPS: "17867717077, +15551234567" },
    () => {
      check("allowlist com 2 e espaço", sparkZapAllowlist().length === 2);
      check("2º da lista casa", pickWaTransport("+15551234567") === "sparkzap");
    },
  );

  await withEnv({ SPARKBOT_WA_TRANSPORT: "STEVO", SPARKZAP_REPS: "+17867717077" }, () => {
    check("flag em stevo ignora allowlist", pickWaTransport("+17867717077") === "stevo");
  });

  // -------------------------------------------------------------------------
  // 2. Envio pela porta /api/ingest/wa/send
  // -------------------------------------------------------------------------
  console.log("\nsparkzap-send — contrato da porta do Spark OS");

  type Captured = { url: string; body: Record<string, unknown>; auth: string };
  const captured: Captured[] = [];
  const realFetch = globalThis.fetch;

  function stubFetch(responder: (n: number) => { status: number; body: unknown }) {
    let n = 0;
    globalThis.fetch = (async (url: unknown, init: RequestInit) => {
      const r = responder(n++);
      captured.push({
        url: String(url),
        body: JSON.parse(String(init.body)) as Record<string, unknown>,
        auth: String((init.headers as Record<string, string>)?.Authorization || ""),
      });
      return new Response(JSON.stringify(r.body), { status: r.status });
    }) as typeof fetch;
  }

  const HUB = "RBFxlEQZobaDjlF2i5px";

  await withEnv(
    { SPARK_OS_WA_URL: "https://os.test/api/ingest/wa/send", SPARK_OS_WA_TOKEN: "seg" },
    async () => {
      captured.length = 0;
      stubFetch(() => ({ status: 200, body: { ok: true, outboxId: "OB1" } }));
      const r = await sendSparkZapText({
        locationId: HUB,
        number: "+17867717077",
        text: "primeira\n---\nsegunda",
        dedupeKey: "MSG123",
      });
      check("splitter `---` vira 2 bolhas", r.total === 2 && r.sent === 2, JSON.stringify(r));
      check("ok quando todas aceitas", r.ok === true);
      check("bearer no header", captured[0].auth === "Bearer seg");
      check("URL da porta", captured[0].url === "https://os.test/api/ingest/wa/send");
      check("locationId no corpo", captured[0].body.locationId === HUB);
      check("kind=text", captured[0].body.kind === "text");
      check("priority 1 (resposta)", captured[0].body.priority === 1);
      check("dedupeKey por bolha (0)", captured[0].body.dedupeKey === "MSG123:0");
      check("dedupeKey por bolha (1)", captured[1].body.dedupeKey === "MSG123:1");
      check("texto da 1ª bolha", captured[0].body.text === "primeira");
      check("outboxId vira id", r.ids[0] === "OB1");

      // 'duplicate' é SUCESSO — a mesma dedupeKey já tinha entrado na fila.
      captured.length = 0;
      stubFetch(() => ({ status: 200, body: { ok: true, duplicate: true } }));
      const dup = await sendSparkZapText({ locationId: HUB, number: "+1786", text: "oi", dedupeKey: "M" });
      check("'duplicate' conta como enviado", dup.ok === true && dup.sent === 1);

      // Falha na 1ª bolha PARA (não manda resposta pela metade duas vezes).
      captured.length = 0;
      stubFetch((n) =>
        n === 0
          ? { status: 503, body: { ok: false, error: "falha ao enfileirar — tente de novo" } }
          : { status: 200, body: { ok: true, outboxId: "X" } },
      );
      const bad = await sendSparkZapText({ locationId: HUB, number: "+1786", text: "a\n---\nb" });
      check(
        "falha na 1ª bolha interrompe",
        bad.ok === false && bad.sent === 0 && captured.length === 1,
      );
      check("erro da porta propagado", (bad.error || "").includes("enfileirar"));

      // Botões: shape do rich.ts (title ≤20 TRUNCADO aqui, id estável).
      captured.length = 0;
      stubFetch(() => ({ status: 200, body: { ok: true, outboxId: "OB9" } }));
      const btn = await sendSparkZapButton({
        locationId: HUB,
        number: "+17867717077",
        body: "Confirma?",
        title: "SparkBot",
        buttons: [
          { id: "confirm", label: "Confirmar mesmo assim ✅" }, // 22 chars → trunca
          { id: "edit", label: "Editar ✏️" },
        ],
        dedupeKey: "MSG9",
      });
      check("botão ok", btn.ok === true && btn.ids[0] === "OB9");
      check("kind=buttons", captured[0].body.kind === "buttons");
      const bPayload = captured[0].body.payload as {
        body: string;
        buttons: Array<{ title: string; id: string }>;
      };
      check("payload.body presente", bPayload.body === "Confirma?");
      check(
        "label truncado a ≤20 (o OS rejeitaria 22)",
        Array.from(bPayload.buttons[0].title).length <= 20,
        bPayload.buttons[0].title,
      );
      check("id estável preservado no truncado", bPayload.buttons[0].id === "confirm");
      check("2º botão intacto", bPayload.buttons[1].title === "Editar ✏️" && bPayload.buttons[1].id === "edit");
      check("dedupeKey do interativo", captured[0].body.dedupeKey === "MSG9:btn");

      // Lista: rowId preservado, cap 10, descrição truncada.
      captured.length = 0;
      stubFetch(() => ({ status: 200, body: { ok: true, outboxId: "OBL" } }));
      const rows = Array.from({ length: 14 }, (_, i) => ({
        rowId: `c${i}`,
        title: `Contato ${i}`,
        description: "x".repeat(100),
      }));
      await sendSparkZapList({
        locationId: HUB,
        number: "+1786",
        body: "Qual deles?",
        buttonText: "Ver opções",
        sections: [{ rows }],
      });
      check("kind=list", captured[0].body.kind === "list");
      const lPayload = captured[0].body.payload as {
        sections: Array<{ rows: Array<{ rowId: string; title: string; description?: string }> }>;
      };
      check("cap de 10 rows aplicado aqui", lPayload.sections[0].rows.length === 10);
      check("rowId preservado", lPayload.sections[0].rows[0].rowId === "c0");
      check(
        "descrição truncada a ≤72",
        Array.from(lPayload.sections[0].rows[0].description || "").length <= 72,
      );

      // 422 da validação do OS → unsupported → o handler cai pro texto.
      captured.length = 0;
      stubFetch(() => ({
        status: 422,
        body: { ok: false, error: "buttons: máximo 3 botões (recebi 4)" },
      }));
      const uns = await sendSparkZapButton({
        locationId: HUB,
        number: "+1786",
        body: "x",
        buttons: [{ id: "a", label: "A" }],
      });
      check("422 é sinalizado como unsupported", uns.ok === false && uns.unsupported === true);
    },
  );

  await withEnv({ SPARK_OS_WA_URL: undefined, SPARK_OS_WA_TOKEN: undefined }, async () => {
    captured.length = 0;
    const r = await sendSparkZapText({ locationId: HUB, number: "+1786", text: "oi" });
    check("sem env não chama a rede", captured.length === 0);
    check("sem env devolve erro claro", r.ok === false && (r.error || "").includes("SPARK_OS_WA_URL"));
  });

  globalThis.fetch = realFetch;

  // -------------------------------------------------------------------------
  // 3. Parser do inbound
  // -------------------------------------------------------------------------
  console.log("\nsparkzap-parser — os dois envelopes");

  const infoOk = {
    ID: "3EB0ABC",
    Chat: "17867717077@s.whatsapp.net",
    Sender: "17867717077@s.whatsapp.net",
    Type: "text",
    IsFromMe: false,
    IsGroup: false,
    PushName: "Pedro",
  };

  const bridged = parseSparkZapWebhook({
    event: "Message",
    instanceName: "sparkbot",
    transport: "sparkzap",
    data: { Info: infoOk, Message: { conversation: "oi" } },
  });
  check("envelope da ponte parseia", bridged.ok === true);
  if (bridged.ok) {
    check("telefone normalizado", bridged.parsed.phone === "+17867717077");
    check("kind=text", bridged.parsed.kind === "text");
    check("marca transport=sparkzap", bridged.parsed.transport === "sparkzap");
    check("messageId preservado", bridged.parsed.messageId === "3EB0ABC");
  }

  const raw = parseSparkZapWebhook({
    type: "Message",
    instanceName: "sparkbot",
    event: { Info: infoOk, Message: { conversation: "oi do engine" } },
  });
  check("envelope CRU do engine parseia", raw.ok === true);
  if (raw.ok) {
    check("texto do envelope cru", raw.parsed.kind === "text" && raw.parsed.text === "oi do engine");
  }

  const lidComAlt = parseSparkZapWebhook({
    type: "Message",
    instanceName: "sparkbot",
    event: {
      Info: {
        ID: "L1",
        Chat: "99999999999@lid",
        Sender: "99999999999@lid",
        SenderAlt: "5511988887777@s.whatsapp.net",
        IsFromMe: false,
        IsGroup: false,
      },
      Message: { conversation: "oi" },
    },
  });
  check("LID com SenderAlt resolve no envelope cru", lidComAlt.ok === true);
  if (lidComAlt.ok) check("telefone do SenderAlt", lidComAlt.parsed.phone === "+5511988887777");

  const lidSemAlt = parseSparkZapWebhook({
    type: "Message",
    instanceName: "sparkbot",
    event: {
      Info: { ID: "L2", Chat: "404@lid", Sender: "404@lid", IsFromMe: false, IsGroup: false },
      Message: { conversation: "oi" },
    },
  });
  check(
    "LID sem alt vira motivo EXPLÍCITO (não descarte mudo)",
    lidSemAlt.ok === false && lidSemAlt.reason === "unresolved_lid",
  );

  const audio = parseSparkZapWebhook({
    event: "Message",
    instanceName: "sparkbot",
    data: {
      Info: { ...infoOk, ID: "A1", Type: "media", MediaType: "ptt" },
      Message: { audioMessage: { mimetype: "audio/ogg", seconds: 9 }, base64: "QUJD" },
    },
  });
  check("áudio parseia pelo base64", audio.ok === true && audio.parsed.kind === "audio");
  if (audio.ok && audio.parsed.kind === "audio") {
    check("base64 chega ao transcritor", audio.parsed.base64 === "QUJD");
    check("duração preservada", audio.parsed.seconds === 9);
  }

  const tap = parseSparkZapWebhook({
    event: "Message",
    instanceName: "sparkbot",
    data: {
      Info: { ...infoOk, ID: "T1" },
      Message: {
        templateButtonReplyMessage: {
          selectedID: "terms_accept",
          selectedDisplayText: "Aceito ✅",
          contextInfo: { stanzaID: "ORIG1" },
        },
      },
    },
  });
  check("tap de botão (formato template) parseia", tap.ok === true);
  if (tap.ok && tap.parsed.kind === "interactive") {
    check("selectionId estável", tap.parsed.selectionId === "terms_accept");
    check("stanza da pergunta original", tap.parsed.replyToStanzaId === "ORIG1");
  }

  check(
    "evento que não é mensagem é ignorado",
    parseSparkZapWebhook({ type: "ReadReceipt", event: {} }).ok === false,
  );
  check("corpo lixo não quebra", parseSparkZapWebhook("nada").ok === false);
  check(
    "fromMe (eco do nosso envio) é ignorado",
    parseSparkZapWebhook({
      event: "Message",
      data: { Info: { ...infoOk, IsFromMe: true }, Message: { conversation: "eco" } },
    }).ok === false,
  );
}

main().then(() => {
  console.log(`\n${pass}/${pass + fail} passaram${fail ? ` — ${fail} FALHARAM` : ""}\n`);
  process.exit(fail ? 1 : 0);
});
