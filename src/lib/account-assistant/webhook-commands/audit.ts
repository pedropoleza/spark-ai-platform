/**
 * Trilha de auditoria + idempotência do comando via webhook (H71).
 *
 * Toda tentativa que passa do rate limit vira uma linha em
 * `sparkbot_webhook_commands` — inclusive as REJEITADAS. Essa é a diferença
 * entre "meu webhook não chegou" virar investigação e virar uma consulta:
 * a linha diz o que chegou, o que barrou e por quê.
 *
 * Idempotência (o webhook do Spark Leads reentrega em cima de timeout, e
 * automação com dois caminhos dispara duas vezes):
 *   - com `request_id` explícito → o índice único barra PRA SEMPRE (predicado
 *     de índice não pode usar `now()`); o SELECT de atalho olha 24h;
 *   - sem ele → impressão digital do conteúdo, janela curta (60s default).
 * A janela curta é de propósito: dois avisos idênticos com 10 minutos de
 * intervalo podem ser intencionais; dois no mesmo segundo, não.
 *
 * CLAIM ANTES DE EXECUTAR (correção da corrida): a linha nasce com
 * `status='running'` ANTES do comando rodar, e `running` conta como duplicata.
 * Sem isso o modo prompt — que leva ~20s de LLM — não enxergava a execução
 * gêmea que começou 2s depois: as duas procuravam por `sent`, nenhuma existia
 * ainda, e o corretor recebia duas mensagens. Linha que FICA em running
 * (lambda morreu no meio) é sinal visível na auditoria, não bug.
 */

import { createHash } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { reportError } from "@/lib/admin-signals/report-error";
import type { ParsedCommand } from "./parse";

export type CommandStatus = "running" | "sent" | "rejected" | "failed" | "duplicate";

/**
 * Status que seguram a vaga da idempotência: já rodando ou já entregue.
 *
 * `duplicate` NÃO entra, e isso é deliberado — a linha de duplicata é
 * REGISTRO, não reserva. Se ela ocupasse: um comando que rodou e FALHOU
 * (hub fora do ar, por exemplo) deixaria pra trás a linha 'duplicate' da
 * reentrega, que sobreviveria ao 'failed' do original e barraria o reenvio
 * daquele `request_id` pra sempre — pior, cada nova tentativa gravaria outra
 * 'duplicate' com `received_at` novo e a janela de 24h se renovaria sozinha.
 * O corretor nunca receberia, e o webhook devolveria 200. Mesma lista do
 * predicado do índice único parcial, de propósito: os dois mecanismos têm
 * que concordar sobre o que é "ocupado".
 */
const STATUS_OCUPADOS = ["running", "sent"] as const;

/**
 * Por quanto tempo uma linha `running` segura a vaga.
 *
 * Execução real cabe em `maxDuration` (60s). Passou muito disso, a lambda
 * morreu no meio e a linha virou órfã: continuar tratando como "em execução"
 * bloquearia aquele `request_id` por 24h e ainda comeria o cap diário do
 * corretor. 5 minutos é folga generosa sobre o teto real.
 */
export const RUNNING_TTL_MS = 5 * 60 * 1000;

export interface AuditEntry {
  locationId: string | null;
  repId: string | null;
  sendTo: string | null;
  kind: string | null;
  message: string | null;
  contactId: string | null;
  requestId: string | null;
  fingerprint: string | null;
  status: CommandStatus;
  reason: string | null;
  detail: string | null;
  deliveredVia: string | null;
  responseText: string | null;
  durationMs: number | null;
  metadata?: Record<string, unknown>;
}

/** Janela (segundos) do dedup por conteúdo quando não há request_id. */
export function dedupWindowSeconds(): number {
  const raw = process.env.SPARKBOT_COMMAND_DEDUP_SECONDS?.trim();
  if (!raw) return 60;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 60;
}

/**
 * Impressão digital do comando — estável e sem guardar o texto na chave.
 * (O separador é NUL — escrito como `\u0000`, NUNCA como o byte cru: um NUL
 * literal no arquivo faz o git tratar o .ts como BINÁRIO, e aí o diff do PR
 * vira "Bin 4569 -> 8809 bytes" e o grep para de achar o conteúdo. Separador
 * é NUL porque, com espaço, "a b"+"c" e "a"+"b c" dariam a mesma digital.)
 *
 * `contactId` entra no hash porque o caso de uso principal do modo prompt é
 * um workflow "novo lead" com texto FIXO e contato variável ("resume esse
 * lead e diz qual o próximo passo"). Sem o contato na digital, dois leads
 * diferentes que caem dentro da janela têm a MESMA digital: o segundo vira
 * "duplicata" e o corretor nunca fica sabendo dele — justo o cenário que a
 * feature existe pra atender, virando silêncio.
 */
export function fingerprintComando(c: ParsedCommand): string {
  return createHash("sha256")
    .update([c.locationId, c.sendTo, c.kind, c.contactId ?? "", c.message].join("\u0000"))
    .digest("hex");
}

/** A linha ainda segura a vaga? `running` velha demais é órfã, não execução. */
function aindaOcupa(linha: { status: string | null; received_at: string | null }): boolean {
  if (linha.status !== "running") return true;
  const t = linha.received_at ? Date.parse(linha.received_at) : NaN;
  if (!Number.isFinite(t)) return true; // sem data confiável, fica fechado
  return Date.now() - t < RUNNING_TTL_MS;
}

/**
 * Já processamos este comando? Devolve o id da linha anterior quando sim.
 * Fail-open: erro de consulta não pode virar entrega bloqueada.
 */
export async function acharDuplicata(c: ParsedCommand, fingerprint: string): Promise<string | null> {
  const supabase = createAdminClient();
  try {
    if (c.requestId) {
      const desde = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const { data, error } = await supabase
        .from("sparkbot_webhook_commands")
        .select("id, status, received_at")
        .eq("location_id", c.locationId)
        .eq("request_id", c.requestId)
        .in("status", STATUS_OCUPADOS as unknown as string[])
        .gte("received_at", desde)
        .order("received_at", { ascending: false })
        .limit(5);
      // supabase-js NÃO lança: sem este if, uma tabela renomeada ou uma RLS
      // errada desligaria o dedup em silêncio e o corretor voltaria a receber
      // mensagem repetida sem uma linha de log dizendo por quê.
      if (error) {
        console.warn(
          "[webhook-command] consulta de duplicata (request_id) falhou, seguindo fail-open:",
          error.message,
        );
        return null;
      }
      // Pega a primeira que AINDA ocupa: uma `running` órfã no topo não pode
      // esconder uma `sent` legítima logo abaixo, nem barrar sozinha.
      return (data ?? []).find(aindaOcupa)?.id ?? null;
    }

    const janela = dedupWindowSeconds();
    if (janela === 0) return null;
    const desde = new Date(Date.now() - janela * 1000).toISOString();
    const { data, error } = await supabase
      .from("sparkbot_webhook_commands")
      .select("id, status, received_at")
      .eq("fingerprint", fingerprint)
      .in("status", STATUS_OCUPADOS as unknown as string[])
      .gte("received_at", desde)
      .order("received_at", { ascending: false })
      .limit(5);
    if (error) {
      console.warn(
        "[webhook-command] consulta de duplicata (fingerprint) falhou, seguindo fail-open:",
        error.message,
      );
      return null;
    }
    return (data ?? []).find(aindaOcupa)?.id ?? null;
  } catch (err) {
    console.warn(
      "[webhook-command] checagem de duplicata falhou (fail-open):",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

function linhaDe(entry: AuditEntry) {
  return {
    location_id: entry.locationId,
    rep_id: entry.repId,
    send_to: entry.sendTo,
    kind: entry.kind,
    message: entry.message,
    contact_id: entry.contactId,
    request_id: entry.requestId,
    fingerprint: entry.fingerprint,
    status: entry.status,
    reason: entry.reason,
    detail: entry.detail,
    delivered_via: entry.deliveredVia,
    response_text: entry.responseText,
    duration_ms: entry.durationMs,
    metadata: entry.metadata ?? {},
  };
}

/** Insere e devolve id + código do erro (o `23505` importa pro claim). */
async function inserirLinha(
  entry: AuditEntry,
): Promise<{ id: string | null; codigo: string | null }> {
  try {
    const supabase = createAdminClient();
    const { data, error } = await supabase
      .from("sparkbot_webhook_commands")
      .insert(linhaDe(entry))
      .select("id")
      .maybeSingle();
    if (error) {
      console.warn("[webhook-command] auditoria não gravou:", error.message);
      return { id: null, codigo: error.code ?? null };
    }
    return { id: data?.id ?? null, codigo: null };
  } catch (err) {
    console.warn(
      "[webhook-command] auditoria lançou (ignorado):",
      err instanceof Error ? err.message : err,
    );
    return { id: null, codigo: null };
  }
}

/** Grava a linha de auditoria. Nunca lança — auditoria não derruba entrega. */
export async function registrarComando(entry: AuditEntry): Promise<string | null> {
  return (await inserirLinha(entry)).id;
}

export interface LinhaBloqueadora {
  id: string;
  status: string | null;
  received_at: string | null;
}

export type ClaimResult =
  | { ok: true; id: string | null }
  /** Outro webhook idêntico já tem a vaga — não executar. */
  | { ok: false; duplicate: true; bloqueio: LinhaBloqueadora | null };

/**
 * Quem está segurando a vaga deste `request_id` — SEM janela de tempo.
 *
 * O índice único parcial não tem recorte temporal (predicado de índice não
 * pode chamar `now()`), então ele barra pra sempre; o SELECT de duplicata só
 * enxerga 24h. Quando as duas visões discordam — típico de um reprocesso do
 * workflow dias depois com o mesmo id — o INSERT estoura 23505 e, sem esta
 * consulta, a rota responderia "comando idêntico entrou em execução no mesmo
 * instante", o que é simplesmente falso e manda o Pedro procurar no lugar
 * errado.
 */
async function acharBloqueio(entry: AuditEntry): Promise<LinhaBloqueadora | null> {
  if (!entry.locationId || !entry.requestId) return null;
  try {
    const supabase = createAdminClient();
    const { data } = await supabase
      .from("sparkbot_webhook_commands")
      .select("id, status, received_at")
      .eq("location_id", entry.locationId)
      .eq("request_id", entry.requestId)
      .in("status", STATUS_OCUPADOS as unknown as string[])
      .order("received_at", { ascending: false })
      .limit(1);
    return (data ?? [])[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Reserva a execução ANTES de rodar o comando.
 *
 * Dois níveis de proteção, e os dois são necessários:
 *   - o SELECT de `acharDuplicata` pega o caso comum (o gêmeo já está lá);
 *   - o índice único parcial `(location_id, request_id)` pega a corrida em que
 *     os dois chegam no mesmo instante e nenhum enxerga o outro. Aí o segundo
 *     INSERT volta `23505` e a gente lê isso como duplicata — que é
 *     exatamente o que é.
 *
 * Sem request_id não há como travar no banco (a impressão digital não é
 * única de propósito: dois avisos iguais com 10min de intervalo são
 * legítimos). Nesse caso vale só o SELECT, que é o suficiente pro reenvio por
 * timeout — o cenário real.
 */
export async function claimComando(entry: AuditEntry): Promise<ClaimResult> {
  const primeira = await inserirLinha({ ...entry, status: "running" });
  if (primeira.codigo !== "23505") {
    // Qualquer outra falha de gravação é fail-open: a auditoria é trilha, não
    // gate. Segue sem id e o resultado tenta gravar a linha inteira no fim.
    return { ok: true, id: primeira.id };
  }

  // Bateu no índice único. Pode ser o gêmeo de verdade — ou uma linha
  // `running` ÓRFÃ de uma lambda que morreu no meio. Se for órfã e a gente
  // desistir aqui, aquele `request_id` fica queimado pra sempre e o comando
  // nunca mais entrega, devolvendo 200 como se estivesse tudo certo.
  if (!(await liberarRunningOrfa(entry))) {
    return { ok: false, duplicate: true, bloqueio: await acharBloqueio(entry) };
  }

  const segunda = await inserirLinha({ ...entry, status: "running" });
  if (segunda.codigo === "23505") {
    return { ok: false, duplicate: true, bloqueio: await acharBloqueio(entry) };
  }
  return { ok: true, id: segunda.id };
}

/**
 * Marca como `failed` a linha `running` que passou do TTL e está segurando a
 * vaga deste `request_id`. Devolve true se liberou alguma.
 */
async function liberarRunningOrfa(entry: AuditEntry): Promise<boolean> {
  if (!entry.locationId || !entry.requestId) return false;
  try {
    const supabase = createAdminClient();
    const limite = new Date(Date.now() - RUNNING_TTL_MS).toISOString();
    const { data, error } = await supabase
      .from("sparkbot_webhook_commands")
      .update({
        status: "failed",
        detail:
          "Execução não terminou (a função foi reciclada no meio). Marcada como falha " +
          "pra não segurar o request_id — o reenvio seguinte roda normalmente.",
      })
      .eq("location_id", entry.locationId)
      .eq("request_id", entry.requestId)
      .eq("status", "running")
      .lt("received_at", limite)
      .select("id");
    if (error) {
      console.warn("[webhook-command] não consegui liberar running órfã:", error.message);
      return false;
    }
    if (data?.length) {
      // Sinal, não só log: linha órfã quer dizer que a função morreu no meio
      // de um comando. Uma vez é ruído; virar rotina é sintoma (prompt
      // estourando o maxDuration) e ninguém ia perceber olhando só a tabela.
      console.warn(
        `[webhook-command] ${data.length} linha(s) 'running' órfã(s) liberada(s) ` +
          `(location ${entry.locationId}, request ${entry.requestId})`,
      );
      reportError({
        title: "Comando via webhook: execução morreu no meio",
        description:
          `A linha 'running' do request ${entry.requestId} (location ${entry.locationId}) passou de ` +
          `${Math.round(RUNNING_TTL_MS / 60000)}min sem fechar — a função foi reciclada antes de terminar. ` +
          "Liberei a vaga pro reenvio. Se repetir, o modo prompt está estourando o maxDuration.",
        feature: "webhook-commands",
        severity: "low",
      });
      return true;
    }
    return false;
  } catch (err) {
    console.warn(
      "[webhook-command] liberação de running órfã lançou (ignorado):",
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}

export interface CommandOutcome {
  status: CommandStatus;
  reason?: string | null;
  detail?: string | null;
  deliveredVia?: string | null;
  responseText?: string | null;
  durationMs?: number | null;
  metadata?: Record<string, unknown>;
}

/**
 * Fecha a linha do claim com o resultado. Quando o claim não chegou a gravar
 * (`id` nulo), grava a linha inteira agora — assim uma falha transitória de
 * INSERT não some com o registro do comando.
 */
export async function finalizarComando(
  id: string | null,
  base: AuditEntry,
  out: CommandOutcome,
): Promise<void> {
  if (!id) {
    await inserirLinha({ ...base, ...outParaEntry(out) });
    return;
  }
  try {
    const supabase = createAdminClient();
    const patch: Record<string, unknown> = { status: out.status };
    if (out.reason !== undefined) patch.reason = out.reason;
    if (out.detail !== undefined) patch.detail = out.detail;
    if (out.deliveredVia !== undefined) patch.delivered_via = out.deliveredVia;
    if (out.responseText !== undefined) patch.response_text = out.responseText;
    if (out.durationMs !== undefined) patch.duration_ms = out.durationMs;
    if (out.metadata !== undefined) patch.metadata = out.metadata;

    const { error } = await supabase
      .from("sparkbot_webhook_commands")
      .update(patch)
      .eq("id", id);
    if (error) console.warn("[webhook-command] auditoria não fechou:", error.message);
  } catch (err) {
    console.warn(
      "[webhook-command] fechamento da auditoria lançou (ignorado):",
      err instanceof Error ? err.message : err,
    );
  }
}

function outParaEntry(out: CommandOutcome): Partial<AuditEntry> {
  return {
    status: out.status,
    reason: out.reason ?? null,
    detail: out.detail ?? null,
    deliveredVia: out.deliveredVia ?? null,
    responseText: out.responseText ?? null,
    durationMs: out.durationMs ?? null,
    ...(out.metadata !== undefined ? { metadata: out.metadata } : {}),
  };
}
