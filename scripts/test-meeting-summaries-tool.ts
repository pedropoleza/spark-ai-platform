/**
 * Testa as tools get_meeting_summaries / attach_meeting_summary (H77) contra um
 * stub HTTP que faz o papel das portas /api/ingest/meetings/* do Spark OS.
 * Roda sem rede externa e sem env de prod.
 *
 * Uso: npx tsx scripts/test-meeting-summaries-tool.ts
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, extra?: unknown) {
  if (ok) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}${extra ? ` — ${JSON.stringify(extra)}` : ""}`);
  }
}

type Handler = (ctx: unknown, args: Record<string, unknown>) => Promise<Record<string, unknown>>;

async function main() {
  // Stub do OS: decide a resposta pelo path + corpo.
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}") as Record<string, unknown>;
      const send = (status: number, payload: unknown) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      if (req.headers.authorization !== "Bearer tok-teste") return send(401, { ok: false, error: "não autorizado" });
      if (req.url === "/api/ingest/meetings/summaries") {
        if (body.location_id === "LOC_VAZIA") return send(200, { ok: true, summaries: [] });
        if (body.location_id === "LOC_500") return send(500, { ok: false, error: "boom" });
        return send(200, {
          ok: true,
          summaries: [
            { id: "ev1", status: "delivered", title: "Call Maria", contact_name: "Maria", note_id: "n1" },
            { id: "ev2", status: "review", title: "Mentoria", pending_reason: "sem match (emails testados: 0)" },
          ],
        });
      }
      if (req.url === "/api/ingest/meetings/attach") {
        if (body.event_id === "ev_outro") return send(409, { ok: false, error: "evento já entregue a outro contato (João)" });
        if (body.event_id === "ev_ja") return send(200, { ok: true, already: true, note_id: "n9", contact_name: "Maria" });
        return send(200, { ok: true, note_id: "n2", contact_name: "Maria" });
      }
      send(404, { ok: false, error: "rota desconhecida" });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;

  // 1) Sem env → erro de configuração honesto (não "não tenho integração").
  delete process.env.SPARK_OS_WA_URL;
  delete process.env.SPARK_OS_WA_TOKEN;
  const { MEETING_SUMMARY_TOOLS } = await import("@/lib/account-assistant/tools/meetings");
  const [getTool, attachTool] = MEETING_SUMMARY_TOOLS;
  const get = getTool.handler as unknown as Handler;
  const attach = attachTool.handler as unknown as Handler;
  const ctx = { locationId: "LOC1" };

  const semEnv = await get(ctx, {});
  check("sem env → error não-retryable com 'não configurada'", semEnv.status === "error" && String(semEnv.message).includes("não configurada"), semEnv);

  // Daqui em diante o stub responde; a URL de envio serve só pra derivar o origin.
  process.env.SPARK_OS_WA_URL = `http://127.0.0.1:${port}/api/ingest/wa/send`;
  process.env.SPARK_OS_WA_TOKEN = "tok-teste";

  // 2) Lista com contagens.
  const lista = (await get(ctx, {})) as { status: string; data: Record<string, unknown> };
  check("lista ok", lista.status === "ok", lista);
  check("contagens delivered/in_review", lista.data.delivered === 1 && lista.data.in_review === 1, lista.data);

  // 3) days clampado 1..30.
  const clamp = (await get(ctx, { days: 999 })) as { data: Record<string, unknown> };
  check("days clampado a 30", clamp.data.days === 30, clamp.data);

  // 4) contact_id inválido barrado ANTES da rede.
  const invalido = await get(ctx, { contact_id: "id com espaço!!" });
  check("contact_id inválido rejeitado", invalido.status === "error", invalido);

  // 5) Lista vazia orienta (não nega a integração à toa).
  const vazia = (await get({ locationId: "LOC_VAZIA" }, {})) as { data: Record<string, unknown> };
  check("vazia → note orientando", String(vazia.data.note).includes("não houve reunião") || String(vazia.data.note).includes("integração"), vazia.data);

  // 6) 500 do OS → retryable.
  const os500 = await get({ locationId: "LOC_500" }, {});
  check("500 → error retryable", os500.status === "error" && os500.retryable === true, os500);

  // 7) Attach feliz.
  const okAttach = (await attach(ctx, { summary_id: "ev1", contact_id: "AbCdEfGhIjKlMnOpQrSt" })) as { status: string; data: Record<string, unknown> };
  check("attach ok devolve contact_name", okAttach.status === "ok" && okAttach.data.contact_name === "Maria", okAttach);

  // 8) Attach em evento de OUTRO contato → 409 vira mensagem clara, sem retry.
  const conflito = await attach(ctx, { summary_id: "ev_outro", contact_id: "AbCdEfGhIjKlMnOpQrSt" });
  check("409 → mensagem 'já foi salvo em outro contato'", conflito.status === "error" && String(conflito.message).includes("outro contato") && conflito.retryable !== true, conflito);

  // 9) Attach idempotente (already).
  const dedup = (await attach(ctx, { summary_id: "ev_ja", contact_id: "AbCdEfGhIjKlMnOpQrSt" })) as { status: string; data: Record<string, unknown> };
  check("already → ok sem duplicar", dedup.status === "ok" && dedup.data.already_saved === true, dedup);

  // 10) Registry expõe as duas tools com os risks certos.
  const { TOOL_REGISTRY } = await import("@/lib/account-assistant/tools/index");
  check("get_meeting_summaries no registry (safe)", TOOL_REGISTRY.get_meeting_summaries?.def.risk === "safe");
  check("attach_meeting_summary no registry (medium)", TOOL_REGISTRY.attach_meeting_summary?.def.risk === "medium");

  server.close();
  console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass}/${pass + fail} passaram`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => {
  console.error("ERRO:", e);
  process.exit(1);
});
