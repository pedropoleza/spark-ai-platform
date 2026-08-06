/**
 * POST /api/webhooks/sparkbot-command — comando via webhook do Spark Leads (H71).
 *
 * Uma automação de dentro de uma sub-conta manda ordem pro SparkBot:
 *   - `notification` → o texto vai CRU pro WhatsApp do corretor;
 *   - `prompt`       → o SparkBot responde e a RESPOSTA dele vai.
 *
 * Três travas, nesta ordem (detalhe em `webhook-commands/authorize.ts`):
 *   1. segredo compartilhado, quando `SPARKBOT_COMMAND_SECRET` existir;
 *   2. a location tem que estar cadastrada nesta plataforma;
 *   3. o telefone de destino tem que ser de corretor DAQUELA location.
 *
 * A regra que mais importa e é a mais fácil de quebrar por engano: o campo
 * `phone` do payload de automação é o telefone do LEAD. Ele NUNCA vira destino
 * — o destino é `send_to`, e é sempre o corretor.
 *
 * Os códigos HTTP são de propósito (não 200-pra-tudo): o log de workflow do
 * Spark Leads mostra o status, então o erro fica visível pro Pedro lá dentro,
 * sem precisar abrir a plataforma.
 */

import { NextRequest, NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { reportError } from "@/lib/admin-signals/report-error";
import { isWebhookCommandsEnabled } from "@/lib/account-assistant/webhook-commands/config";
import {
  parseWebhookCommand,
  extrairLocationId,
  type ParsedCommand,
} from "@/lib/account-assistant/webhook-commands/parse";
import { authorizeCommand } from "@/lib/account-assistant/webhook-commands/authorize";
import {
  acharDuplicata,
  claimComando,
  finalizarComando,
  fingerprintComando,
  registrarComando,
  type AuditEntry,
} from "@/lib/account-assistant/webhook-commands/audit";
import {
  contarEnviosRecentes,
  dailyCap,
  executeWebhookCommand,
} from "@/lib/account-assistant/webhook-commands/run";

export const maxDuration = 60;

// ── Rate limit por location ─────────────────────────────────────────────────
// Vem ANTES da auditoria de propósito: é isto que impede um workflow em loop
// de inflar a tabela com milhares de linhas rejeitadas. Mesmo padrão (Map em
// memória + eviction preguiçosa amortizada) do inbound-message; setInterval
// não cabe em serverless, o timer morre com a lambda.
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_WINDOW = 60_000;
const RATE_LIMIT_MAX = 30;
const RATE_LIMIT_SWEEP_EVERY = 500;
let rateLimitCalls = 0;

function checkRateLimit(chave: string): boolean {
  const now = Date.now();
  if (++rateLimitCalls >= RATE_LIMIT_SWEEP_EVERY) {
    rateLimitCalls = 0;
    for (const [k, e] of rateLimitMap) if (now > e.resetAt) rateLimitMap.delete(k);
  }
  const entry = rateLimitMap.get(chave);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(chave, { count: 1, resetAt: now + RATE_LIMIT_WINDOW });
    return true;
  }
  entry.count++;
  return entry.count <= RATE_LIMIT_MAX;
}

// ── Auditoria ───────────────────────────────────────────────────────────────

function entradaBase(over: Partial<AuditEntry>): AuditEntry {
  return {
    locationId: null,
    repId: null,
    sendTo: null,
    kind: null,
    message: null,
    contactId: null,
    requestId: null,
    fingerprint: null,
    status: "rejected",
    reason: null,
    detail: null,
    deliveredVia: null,
    responseText: null,
    durationMs: null,
    ...over,
  };
}

function entradaDoComando(c: ParsedCommand, fingerprint: string): AuditEntry {
  return entradaBase({
    locationId: c.locationId,
    sendTo: c.sendTo,
    kind: c.kind,
    message: c.message,
    contactId: c.contactId,
    requestId: c.requestId,
    fingerprint,
  });
}

/** Erro com corpo legível + linha na auditoria. */
async function recusar(
  status: number,
  reason: string,
  detail: string,
  entry: AuditEntry,
): Promise<NextResponse> {
  const id = await registrarComando({ ...entry, status: "rejected", reason, detail });
  return NextResponse.json({ ok: false, error: reason, detail, audit_id: id }, { status });
}

// ── Handler ─────────────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  if (!isWebhookCommandsEnabled()) {
    return NextResponse.json(
      {
        ok: false,
        error: "feature_desligada",
        detail:
          "Os comandos via webhook estão desligados nesta plataforma " +
          "(SPARKBOT_WEBHOOK_COMMANDS_ENABLED).",
      },
      { status: 503 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      {
        ok: false,
        error: "payload_invalido",
        detail: "O corpo do webhook não é um JSON válido. Confere o Content-Type e o body da ação.",
      },
      { status: 400 },
    );
  }

  // Chave do rate limit: a location quando dá pra ler, senão o IP — payload
  // quebrado em loop também não pode martelar o endpoint.
  const locationBruta =
    extrairLocationId((body ?? {}) as Record<string, unknown>) ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "desconhecida";
  if (!checkRateLimit(locationBruta)) {
    return NextResponse.json(
      {
        ok: false,
        error: "rate_limited",
        detail: `Mais de ${RATE_LIMIT_MAX} comandos em 1 minuto desta conta. Confere se a automação não entrou em loop.`,
      },
      { status: 429 },
    );
  }

  // ── 1. Parse ──────────────────────────────────────────────────────────
  const parsed = parseWebhookCommand(body);
  if (!parsed.ok) {
    return recusar(
      400,
      parsed.reason,
      parsed.detail,
      entradaBase({ locationId: extrairLocationId((body ?? {}) as Record<string, unknown>) }),
    );
  }
  const command = parsed.command;
  const fingerprint = fingerprintComando(command);
  const base = entradaDoComando(command, fingerprint);

  // ── 2. Autorização ────────────────────────────────────────────────────
  const auth = await authorizeCommand({
    locationId: command.locationId,
    sendTo: command.sendTo,
    segredoHeader: request.headers.get("x-spark-secret"),
    segredoBody: command.secret,
  });
  if (!auth.ok) {
    return recusar(auth.httpStatus, auth.reason, auth.detail, base);
  }
  const target = auth.target;
  const comRep: AuditEntry = { ...base, repId: target.rep.id };

  // ── 3. Duplicata ──────────────────────────────────────────────────────
  const anterior = await acharDuplicata(command, fingerprint);
  if (anterior) {
    const id = await registrarComando({
      ...comRep,
      status: "duplicate",
      reason: "duplicata",
      detail: `Comando idêntico já processado (auditoria ${anterior}). Não reenviei.`,
      metadata: { duplicate_of: anterior },
    });
    return NextResponse.json(
      { ok: true, duplicate: true, duplicate_of: anterior, audit_id: id },
      { status: 200 },
    );
  }

  // ── 4. Cap diário por corretor ────────────────────────────────────────
  const cap = dailyCap();
  if (cap > 0) {
    const jaEnviados = await contarEnviosRecentes(target.rep.id);
    if (jaEnviados >= cap) {
      return recusar(
        429,
        "cap_diario",
        `O corretor ${target.rep.display_name || command.sendTo} já recebeu ${jaEnviados} comandos nas últimas 24h ` +
          `(limite ${cap}). Isso costuma ser automação em loop — o limite se ajusta em SPARKBOT_COMMAND_DAILY_CAP.`,
        comRep,
      );
    }
  }

  // ── 5. Claim: reserva a execução ANTES de rodar ───────────────────────
  // Sem isto, dois webhooks gêmeos no modo prompt (que leva ~20s) não se
  // enxergam — os dois procuram por uma linha que nenhum gravou ainda — e o
  // corretor recebe a mesma mensagem duas vezes.
  const claim = await claimComando(comRep);
  if (!claim.ok) {
    return NextResponse.json(
      {
        ok: true,
        duplicate: true,
        detail: "Um comando idêntico entrou em execução no mesmo instante. Não reenviei.",
      },
      { status: 200 },
    );
  }
  const auditId = claim.id;

  // ── 6. Execução ───────────────────────────────────────────────────────
  // `notification` é síncrono: é um envio só (~2s) e o resultado tem que
  // aparecer na resposta pro Pedro conseguir testar. `prompt` roda LLM com
  // tools e estouraria o timeout do webhook do Spark Leads — devolvemos 202 e
  // terminamos em background; a prova é a mensagem chegando no WhatsApp mais a
  // linha na auditoria.
  if (command.kind === "notification") {
    const resultado = await executeWebhookCommand(command, target);
    await finalizarComando(auditId, comRep, {
      status: resultado.status,
      deliveredVia: resultado.via ?? null,
      responseText: resultado.deliveredText ?? null,
      detail: resultado.detail ?? null,
      durationMs: resultado.durationMs,
    });
    return NextResponse.json(
      {
        ok: resultado.status === "sent",
        status: resultado.status,
        via: resultado.via ?? null,
        detail: resultado.detail ?? null,
        audit_id: auditId,
      },
      { status: resultado.status === "sent" ? 200 : 502 },
    );
  }

  waitUntil(
    (async () => {
      try {
        const resultado = await executeWebhookCommand(command, target);
        await finalizarComando(auditId, comRep, {
          status: resultado.status,
          deliveredVia: resultado.via ?? null,
          responseText: resultado.deliveredText ?? null,
          detail: resultado.detail ?? null,
          durationMs: resultado.durationMs,
          metadata: {
            ...(resultado.model ? { model: resultado.model } : {}),
            ...(resultado.toolsUsed?.length ? { tools: resultado.toolsUsed } : {}),
          },
        });
      } catch (err) {
        // executeWebhookCommand já captura o que acontece DENTRO dele; aqui só
        // sobra falha do próprio fechamento. Sem este catch a linha ficaria
        // 'running' pra sempre sem ninguém saber por quê.
        const detail = err instanceof Error ? err.message : String(err);
        console.error("[sparkbot-command] execução em background falhou:", detail);
        reportError({
          title: "Comando via webhook: execução em background falhou",
          feature: "webhook-commands",
          severity: "medium",
          error: err,
        });
        await finalizarComando(auditId, comRep, { status: "failed", detail });
      }
    })(),
  );

  return NextResponse.json(
    {
      ok: true,
      accepted: true,
      detail:
        "Comando aceito. O SparkBot está montando a resposta e ela chega no WhatsApp do corretor em alguns segundos.",
      audit_id: auditId,
    },
    { status: 202 },
  );
}

/** Abrir a URL no navegador não pode parecer que o endpoint está quebrado. */
export function GET() {
  return NextResponse.json(
    {
      ok: false,
      error: "metodo_invalido",
      detail:
        "Este endpoint recebe POST com JSON. Campos: location_id, message_type " +
        "(`notification` ou `prompt`), send_to (telefone do CORRETOR) e message (ou prompt).",
    },
    { status: 405 },
  );
}
