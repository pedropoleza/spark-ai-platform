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
 * A trava 1 roda AQUI, antes do parse e de qualquer escrita (ver bloco 0). As
 * outras duas ficam no authorize, depois de a auditoria já ter registro do que
 * chegou. `authorize` reconfere o segredo de propósito — é defesa em
 * profundidade pra quem chamar aquela função de outro lugar.
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
  extrairSegredo,
  type ParsedCommand,
} from "@/lib/account-assistant/webhook-commands/parse";
import {
  authorizeCommand,
  verificarSegredo,
} from "@/lib/account-assistant/webhook-commands/authorize";
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

// ── Rate limit ──────────────────────────────────────────────────────────────
// Vem ANTES da auditoria de propósito: é isto que impede um workflow em loop
// de inflar a tabela com milhares de linhas rejeitadas. Mesmo padrão (Map em
// memória + eviction preguiçosa amortizada) do inbound-message; setInterval
// não cabe em serverless, o timer morre com a lambda.
//
// DUAS chaves, e a de IP é a que segura de verdade. O `location_id` vem do
// CORPO — quem manda escolhe. Limitando só por ele, bastava variar o campo a
// cada requisição pra nunca bater no teto e, de quebra, encher o Map de
// chaves inventadas. O IP é o único identificador que o chamador não escolhe.
// A chave por location continua valendo: é ela que pega o caso REAL (uma
// automação da conta em loop), com mensagem que aponta pro problema certo.
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_WINDOW = 60_000;
const RATE_LIMIT_MAX = 30;
/** Teto por origem de rede — mais folgado: uma agência pode ter várias contas. */
const RATE_LIMIT_MAX_IP = 120;
const RATE_LIMIT_SWEEP_EVERY = 500;
/** Teto duro do Map: mesmo com chave escolhida pelo chamador, a memória não voa. */
const RATE_LIMIT_MAX_KEYS = 5_000;
let rateLimitCalls = 0;

function checkRateLimit(chave: string, teto: number): boolean {
  const now = Date.now();
  if (++rateLimitCalls >= RATE_LIMIT_SWEEP_EVERY) {
    rateLimitCalls = 0;
    for (const [k, e] of rateLimitMap) if (now > e.resetAt) rateLimitMap.delete(k);
  }
  const entry = rateLimitMap.get(chave);
  if (!entry || now > entry.resetAt) {
    if (rateLimitMap.size >= RATE_LIMIT_MAX_KEYS) {
      // Estourou o teto: varre agora (fora do amortizado) e, se ainda assim
      // não couber, descarta a entrada mais velha. Perder contagem antiga é
      // melhor que crescer sem limite — a janela é de 1 minuto.
      for (const [k, e] of rateLimitMap) if (now > e.resetAt) rateLimitMap.delete(k);
      if (rateLimitMap.size >= RATE_LIMIT_MAX_KEYS) {
        const maisVelha = rateLimitMap.keys().next().value;
        if (maisVelha !== undefined) rateLimitMap.delete(maisVelha);
      }
    }
    rateLimitMap.set(chave, { count: 1, resetAt: now + RATE_LIMIT_WINDOW });
    return true;
  }
  entry.count++;
  return entry.count <= teto;
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

/**
 * Traduz o resultado da entrega pra uma frase que se entende sozinha.
 *
 * `deliverProactiveMessage` devolve códigos internos e o mais confuso é o
 * `blocked_no_optin`: ele vem com `ok: true` porque a mensagem FOI entregue —
 * no painel web, não no WhatsApp. É o gate de opt-in anti-ban da Meta, não
 * falha. Sem esta tradução, quem testasse de fora leria "blocked" e abriria
 * chamado de bug pra comportamento correto.
 */
function explicarEntrega(
  via: "whatsapp" | "system" | undefined,
  erro: string | undefined,
): string | null {
  if (erro === "blocked_no_optin") {
    return (
      "Entregue no painel web, não no WhatsApp: esse corretor ainda não escreveu " +
      "pro SparkBot nenhuma vez. Basta ele mandar uma mensagem qualquer pro número " +
      "do bot que os próximos comandos vão pelo WhatsApp. (Gate de opt-in anti-ban " +
      "da Meta — não é erro.)"
    );
  }
  if (via === "system" && !erro) {
    return "Entregue no painel web (o WhatsApp não estava disponível pra esse corretor).";
  }
  return erro ?? null;
}

/**
 * Retrato do payload pra linha de recusa: só os NOMES dos campos que vieram
 * (com os aninhados de 1 nível), nunca os valores. O payload de automação
 * carrega dado do lead — guardar isso numa recusa seria acumular informação
 * pessoal sem necessidade. Os nomes bastam pra ver o que faltou.
 */
function resumoDoPayload(corpo: Record<string, unknown>): string[] {
  const nomes: string[] = [];
  for (const [k, v] of Object.entries(corpo).slice(0, 60)) {
    nomes.push(k);
    if (v && typeof v === "object" && !Array.isArray(v)) {
      for (const sub of Object.keys(v as Record<string, unknown>).slice(0, 30)) {
        nomes.push(`${k}.${sub}`);
      }
    }
  }
  return nomes;
}

/**
 * Erro com corpo legível + linha na auditoria.
 *
 * `auditReason`/`auditDetail` existem pra quando a resposta pública é de
 * propósito mais vaga que a verdade (ver `telefone_fora_da_location` no
 * authorize): quem chamou recebe o suficiente pra consertar a automação, e o
 * motivo exato fica na auditoria, que só nós lemos.
 */
async function recusar(
  status: number,
  reason: string,
  detail: string,
  entry: AuditEntry,
  audit?: { reason?: string; detail?: string },
): Promise<NextResponse> {
  const id = await registrarComando({
    ...entry,
    status: "rejected",
    reason: audit?.reason ?? reason,
    detail: audit?.detail ?? detail,
    ...(audit?.reason ? { metadata: { ...(entry.metadata ?? {}), resposta_publica: reason } } : {}),
  });
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

  const corpo = (body ?? {}) as Record<string, unknown>;
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "sem-ip";
  const locationBruta = extrairLocationId(corpo);

  // IP primeiro: é o teto que o chamador não consegue driblar variando campo.
  if (!checkRateLimit(`ip:${ip}`, RATE_LIMIT_MAX_IP)) {
    console.warn(`[sparkbot-command] rate limit por IP (${ip}) — ${RATE_LIMIT_MAX_IP}/min estourado`);
    return NextResponse.json(
      {
        ok: false,
        error: "rate_limited",
        detail: `Mais de ${RATE_LIMIT_MAX_IP} comandos em 1 minuto desta origem.`,
      },
      { status: 429 },
    );
  }
  if (locationBruta && !checkRateLimit(`loc:${locationBruta}`, RATE_LIMIT_MAX)) {
    // Log porque a auditoria NÃO grava este caminho (é justamente o que
    // impede o loop de inflar a tabela) — sem esta linha, uma automação em
    // loop seria invisível nos dois lugares.
    console.warn(
      `[sparkbot-command] rate limit por location (${locationBruta}) — ${RATE_LIMIT_MAX}/min estourado`,
    );
    return NextResponse.json(
      {
        ok: false,
        error: "rate_limited",
        detail: `Mais de ${RATE_LIMIT_MAX} comandos em 1 minuto desta conta. Confere se a automação não entrou em loop.`,
      },
      { status: 429 },
    );
  }

  // ── 0. Segredo, ANTES de tocar no banco ───────────────────────────────
  // A auditoria grava toda tentativa que passa daqui — inclusive as recusadas —
  // e isso é o que faz "meu webhook não chegou" virar consulta em vez de
  // investigação. Só que o endpoint é PÚBLICO: com a conferência de segredo
  // depois do parse (como era até 2026-08-06), um `POST {}` anônimo já deixava
  // linha, e qualquer um na internet escrevia na tabela a 120/min por IP.
  //
  // A recusa por segredo é o ÚNICO caminho da rota que não grava linha, de
  // propósito: é o único que um estranho consegue alcançar. Quem tem o segredo
  // (a automação de verdade) continua com auditoria completa de tudo que vier
  // torto depois daqui — que é justamente o caso de uso do debug.
  //
  // Visibilidade não se perde: vai sinal pro painel, e `reportError` deduplica
  // por título estável, então nem uma enxurrada vira enxurrada de linha. Se uma
  // automação legítima começar a falhar por segredo velho, aparece lá — e o 401
  // aparece no log de workflow do Spark Leads, que é onde o Pedro olha primeiro.
  const segredo = verificarSegredo(
    request.headers.get("x-spark-secret"),
    extrairSegredo(corpo),
  );
  if (!segredo.ok) {
    console.warn(`[sparkbot-command] ${segredo.reason} (ip ${ip}, location ${locationBruta ?? "?"})`);
    reportError({
      title: "Comando via webhook: segredo recusado",
      feature: "webhook-commands",
      severity: "low",
      description:
        "Alguém chamou o endpoint de comandos sem o segredo correto. Se for automação nossa, " +
        "o segredo mudou ou ficou pra trás na ação de webhook; se não for, é ruído da internet " +
        "(a recusa não grava auditoria de propósito, pra não deixarem lixo na tabela).",
      metadata: { motivo: segredo.reason, location_id: locationBruta, ip },
    });
    return NextResponse.json(
      { ok: false, error: segredo.reason, detail: segredo.detail },
      { status: 401 },
    );
  }

  // ── 1. Parse ──────────────────────────────────────────────────────────
  const parsed = parseWebhookCommand(body);
  if (!parsed.ok) {
    return recusar(
      400,
      parsed.reason,
      parsed.detail,
      entradaBase({
        locationId: locationBruta,
        // Sem isto, a linha de recusa não guarda NADA do que chegou e o
        // "por que meu webhook não passou?" volta a ser adivinhação. Só os
        // nomes dos campos e o tamanho — o conteúdo do payload de automação
        // carrega dado do lead e não precisa ficar guardado numa recusa.
        metadata: { payload_campos: resumoDoPayload(corpo) },
      }),
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
    return recusar(auth.httpStatus, auth.reason, auth.detail, base, {
      reason: auth.auditReason,
      detail: auth.auditDetail,
    });
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

  // ── 4. Claim: reserva a execução ANTES de rodar ───────────────────────
  // Sem isto, dois webhooks gêmeos no modo prompt (que leva ~20s) não se
  // enxergam — os dois procuram por uma linha que nenhum gravou ainda — e o
  // corretor recebe a mesma mensagem duas vezes.
  const claim = await claimComando(comRep);
  if (!claim.ok) {
    // Grava a linha ANTES de responder. O 23505 é o caminho mais raro e o mais
    // difícil de acreditar depois ("o webhook devolveu 200 e nada chegou") —
    // se ele não deixar registro, é o único desfecho da rota que some sem
    // rastro. A linha nasce 'duplicate', que NÃO ocupa vaga de idempotência.
    //
    // E o texto tem que dizer a verdade: o índice barra PRA SEMPRE (não dá pra
    // pôr `now()` num predicado de índice), então essa colisão tanto pode ser
    // o webhook gêmeo de agora quanto um reprocesso do MESMO evento dias
    // depois. Dizer "no mesmo instante" nos dois casos mandaria o Pedro
    // procurar no lugar errado.
    const b = claim.bloqueio;
    const quando = b?.received_at ? new Date(b.received_at) : null;
    const recente = quando ? Date.now() - quando.getTime() < 5 * 60_000 : true;
    const detalhe = recente
      ? "Outro webhook com o mesmo request_id reservou a execução agora há pouco. Não reenviei."
      : `Este request_id já foi processado em ${quando?.toISOString()} (situação: ${b?.status}). ` +
        "Como ele é a chave de idempotência, o mesmo id nunca reenvia — se a intenção era mandar " +
        "de novo, use um request_id novo (ou tire o campo).";
    const id = await registrarComando({
      ...comRep,
      status: "duplicate",
      reason: recente ? "duplicata_na_corrida" : "request_id_ja_usado",
      detail: detalhe,
      metadata: b ? { bloqueado_por: b.id, status_anterior: b.status, em: b.received_at } : {},
    });
    return NextResponse.json(
      {
        ok: true,
        duplicate: true,
        audit_id: id,
        ...(b ? { duplicate_of: b.id } : {}),
        detail: detalhe,
      },
      { status: 200 },
    );
  }
  const auditId = claim.id;

  // ── 5. Cap diário por corretor — DEPOIS do claim ──────────────────────
  // A ordem é o que faz o cap valer. Contando ANTES de gravar, uma rajada
  // simultânea lê a mesma contagem antiga e passa inteira pelo limite (e o
  // rate limit acima não cobre: o Map vive na memória de UMA instância, e o
  // Vercel abre várias). Contando DEPOIS, a própria linha 'running' já está
  // no banco, então cada requisição da rajada enxerga as irmãs e só as que
  // couberem no limite seguem. Por isso a comparação é `>` e não `>=`.
  const cap = dailyCap();
  if (cap > 0) {
    const total = await contarEnviosRecentes(target.rep.id);
    if (total > cap) {
      const detalhe =
        `O corretor ${target.rep.display_name || command.sendTo} já recebeu ${total - 1} comandos nas últimas 24h ` +
        `(limite ${cap}). Isso costuma ser automação em loop — o limite se ajusta em SPARKBOT_COMMAND_DAILY_CAP.`;
      await finalizarComando(auditId, comRep, {
        status: "rejected",
        reason: "cap_diario",
        detail: detalhe,
      });
      return NextResponse.json(
        { ok: false, error: "cap_diario", detail: detalhe, audit_id: auditId },
        { status: 429 },
      );
    }
  }

  // ── 6. Execução ───────────────────────────────────────────────────────
  // `notification` é síncrono: é um envio só (~2s) e o resultado tem que
  // aparecer na resposta pro Pedro conseguir testar. `prompt` roda LLM com
  // tools e estouraria o timeout do webhook do Spark Leads — devolvemos 202 e
  // terminamos em background; a prova é a mensagem chegando no WhatsApp mais a
  // linha na auditoria.
  if (command.kind === "notification") {
    const resultado = await executeWebhookCommand(command, target);
    const explicacao = explicarEntrega(resultado.via, resultado.detail);
    await finalizarComando(auditId, comRep, {
      status: resultado.status,
      deliveredVia: resultado.via ?? null,
      responseText: resultado.deliveredText ?? null,
      detail: explicacao,
      durationMs: resultado.durationMs,
    });
    return NextResponse.json(
      {
        ok: resultado.status === "sent",
        status: resultado.status,
        via: resultado.via ?? null,
        detail: explicacao,
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
          detail: explicarEntrega(resultado.via, resultado.detail),
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
