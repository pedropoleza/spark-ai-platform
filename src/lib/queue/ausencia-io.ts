/**
 * O lado com I/O da ausência do lead (H128): junta as falas da conversa e busca
 * horários depois da volta. A leitura e as decisões são puras (ausencia-lead.ts).
 */

import type { createAdminClient } from "@/lib/supabase/admin";
import { isChatMessageType } from "@/lib/ghl/message-sources";
import { filterSlotsToBusinessHours } from "@/lib/ai/slots-format";
import { normalizarFala } from "@/lib/queue/escolha-de-horario";
import {
  buscarMaisHorariosDesde,
  filtrarSlotsDaAusencia,
  juntarSlots,
  lerAusencias,
  rotuloDasAusencias,
  type Ausencia,
  type FalaDaConversa,
} from "@/lib/queue/ausencia-lead";

/** O histórico do CRM traz ~20 mensagens; a fila guarda o que o lead disse antes. */
const DIAS_DE_FILA = 30;

/** Junta as falas e tira a repetida (o mesmo texto chega por WhatsApp e SMS, e pelo CRM e pela fila). */
export function juntarFalas(falas: readonly FalaDaConversa[]): FalaDaConversa[] {
  const ordenadas = [...falas].filter((f) => f.texto.trim() && !isNaN(Date.parse(f.em))).sort((a, b) => Date.parse(a.em) - Date.parse(b.em));
  const out: Array<FalaDaConversa & { norm: string }> = [];
  for (const f of ordenadas) {
    const norm = normalizarFala(f.texto);
    const repetida = out.some((x) => x.de === f.de && x.norm === norm && Date.parse(f.em) - Date.parse(x.em) < 5 * 60_000);
    if (!repetida) out.push({ ...f, norm });
  }
  return out.map((f) => ({ de: f.de, texto: f.texto, em: f.em }));
}

/** Falas da conversa: histórico do CRM + fila (30 dias) + o turno. Falha da fila é silenciosa. */
export async function falasDaConversa(p: {
  supabase: ReturnType<typeof createAdminClient>;
  locationId: string;
  contactId: string;
  historico: ReadonlyArray<{ direction?: string | null; body?: string | null; dateAdded?: string | null; messageType?: string | null }>;
  /** O que o lead mandou neste turno, já junto e com áudio transcrito. */
  turno: { texto: string; desde: string; em: string } | null;
  agora: Date;
}): Promise<FalaDaConversa[]> {
  let falas: FalaDaConversa[] = p.historico
    .filter((m) => m.body && m.dateAdded && isChatMessageType(m.messageType ?? undefined))
    .map((m) => ({ de: m.direction === "inbound" ? ("lead" as const) : ("nos" as const), texto: String(m.body), em: String(m.dateAdded) }));
  try {
    const { data } = await p.supabase
      .from("message_queue")
      .select("message_body, received_at")
      .eq("location_id", p.locationId)
      .eq("contact_id", p.contactId)
      .eq("message_direction", "inbound")
      .gte("received_at", new Date(p.agora.getTime() - DIAS_DE_FILA * 86_400_000).toISOString())
      .order("received_at", { ascending: false })
      .limit(150);
    for (const m of data || []) {
      if (m.message_body && m.received_at) falas.push({ de: "lead", texto: String(m.message_body), em: String(m.received_at) });
    }
  } catch (e) {
    console.warn("[Ausencia] fila do lead indisponível (segue com o histórico):", e instanceof Error ? e.message : e);
  }
  if (p.turno) {
    // As mensagens do turno já estão juntas no texto dele: não as lê de novo soltas.
    const corte = Date.parse(p.turno.desde) - 15_000;
    falas = falas.filter((f) => f.de === "nos" || Date.parse(f.em) < corte);
    falas.push({ de: "lead", texto: p.turno.texto, em: p.turno.em });
  }
  return juntarFalas(falas);
}

export interface AgendaComAusencia {
  /** Resposta do free-slots sem os dias em que o lead está fora (e com os de depois da volta). */
  slots: Record<string, unknown>;
  ausencias: Ausencia[];
  rotulo: string;
  semVolta: boolean;
  retirados: number;
  buscouMais: boolean;
}

const contar = (s: Record<string, unknown>) =>
  Object.entries(s).reduce((n, [k, v]) => n + (k !== "traceId" && v && Array.isArray((v as { slots?: unknown[] }).slots) ? (v as { slots: unknown[] }).slots.length : 0), 0);

/**
 * Aplica a ausência à agenda do turno. Com menos de 2 dias sobrando, busca os horários
 * a partir da volta (`buscarDesde`): a janela padrão é de 7 dias, e sem isso a IA
 * ficaria sem nada para oferecer (ou insistiria na semana recusada, caso 21/11/2026).
 */
export async function agendaComAusencia(p: {
  slots: Record<string, unknown>;
  falas: readonly FalaDaConversa[];
  /** Fuso do lead, ou o da conta. */
  tzLead: string;
  tzConta: string;
  agora: Date;
  /** Até quando foi a consulta de horários deste turno. */
  fimDaJanela: Date;
  buscarDesde: (desde: Date) => Promise<Record<string, unknown> | null>;
}): Promise<AgendaComAusencia> {
  // Rede de segurança: ler a conversa nunca pode derrubar o turno.
  let lida: ReturnType<typeof lerAusencias>;
  try {
    lida = lerAusencias(p.falas, p.tzLead, p.agora);
  } catch (e) {
    console.error("[Ausencia] leitura falhou (segue sem):", e instanceof Error ? e.message : e);
    lida = { ausencias: [], semVolta: false };
  }
  const { ausencias, semVolta } = lida;
  if (ausencias.length === 0) return { slots: p.slots, ausencias, rotulo: "", semVolta, retirados: 0, buscouMais: false };
  let slots = filtrarSlotsDaAusencia(p.slots, ausencias, p.tzLead);
  const retirados = contar(p.slots) - contar(slots);
  let buscouMais = false;
  const desde = buscarMaisHorariosDesde(slots, ausencias, p.tzLead, p.agora, p.fimDaJanela);
  if (desde) {
    try {
      const extra = await p.buscarDesde(desde);
      if (extra) {
        buscouMais = true;
        slots = juntarSlots(slots, filtrarSlotsDaAusencia(filterSlotsToBusinessHours(extra, p.tzConta), ausencias, p.tzLead));
      }
    } catch (e) {
      console.warn("[Ausencia] free-slots depois da volta falhou (segue sem):", e instanceof Error ? e.message : e);
    }
  }
  return { slots, ausencias, rotulo: rotuloDasAusencias(ausencias, p.tzLead, p.agora), semVolta, retirados, buscouMais };
}
