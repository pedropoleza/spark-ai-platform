/**
 * H83 (pedido do Pedro 2026-08-26) — avisa um humano no WhatsApp quando o
 * atendimento da IA TRAVA, PARA ou FALHA.
 *
 * O que existia antes disto:
 *  - `handoff_policy.notify_rep_via_sparkbot` avisa em UM caso só: o
 *    `should_respond` decidir SKIP (lead pediu humano, humano respondeu antes,
 *    oportunidade fechada). É o caminho "a IA escolheu não falar".
 *  - `notifications.on_error` / `on_handed_off` / `on_qualified` / `on_booked`
 *    existiam no tipo, no zod e na UI — e NENHUM ponto do runtime lia. Os três
 *    últimos foram removidos da UI pelo F29 justamente por serem dead-write, e
 *    o `on_error` que sobrou dispara sinal TÉCNICO pra equipe, não pro cliente.
 *
 * Ou seja: quando o turno estourava, o envio falhava ou a IA se pausava sozinha,
 * o lead ficava parado e NINGUÉM da operação era avisado. É o que este módulo
 * resolve.
 *
 * Desenho:
 *  - opt-in explícito por agente (`notifications.alerta_whatsapp`), com o
 *    telefone do destinatário. Sem isso configurado, nada acontece — nenhuma
 *    conta da frota muda de comportamento.
 *  - o destinatário precisa ser um rep de `rep_identities` (é quem o SparkBot
 *    sabe endereçar) e ter feito opt-in mandando ao menos uma mensagem pelo
 *    WhatsApp; senão o aviso cai no painel web (o `deliverProactiveMessage`
 *    protege contra ban da Meta).
 *  - anti-tempestade em DUAS camadas: cooldown por (agente, contato, motivo) e
 *    teto por hora na location. Um agente quebrado não vira 200 mensagens.
 *  - `dr.ok` NÃO é prova de entrega (H71): quem diz é o `via`.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { normalizePhone } from "@/lib/account-assistant/identity";

export type MotivoAlerta =
  | "turno_falhou"
  | "envio_falhou"
  | "ia_pausada"
  /**
   * NÃO enganchado aqui de propósito. O caso "a IA fechou o turno em
   * handed_off" é do H85 (`handoff_policy.notify_rep_on_llm_handoff` →
   * `notifyLlmHandoffToRep`), construído em paralelo na sessão da Marina.
   * Enganchar os dois mandaria mensagem em dobro pro mesmo rep. Fica declarado
   * porque a config aceita o valor — quem ligar assume que é redundante.
   */
  | "passou_pra_humano";

/** Cooldown por (agente, contato, motivo). O mesmo problema no mesmo lead não repete. */
const COOLDOWN_MIN = 120;
/** Teto por location/hora — backstop contra falha sistêmica virando spam. */
const TETO_HORA = 8;

export interface ConfigAlerta {
  enabled?: boolean;
  phone?: string;
  /** Motivos ligados. Ausente = todos. */
  motivos?: MotivoAlerta[];
}

interface Args {
  agentId: string;
  agentName?: string | null;
  locationId: string;
  contactId: string;
  motivo: MotivoAlerta;
  /** Uma linha em PT-BR explicando o que houve (vai pro rep, sem jargão). */
  detalhe: string;
  nomeContato?: string | null;
  config?: unknown;
}

export interface ResultadoAlerta {
  enviado: boolean;
  motivo_skip?:
    | "desligado"
    | "motivo_nao_assinado"
    | "sem_telefone"
    | "rep_nao_cadastrado"
    | "cooldown"
    | "teto_hora"
    | "entrega_falhou";
  via?: string;
}

const ROTULO: Record<MotivoAlerta, string> = {
  turno_falhou: "A IA travou e não conseguiu responder",
  envio_falhou: "A resposta da IA não chegou no lead",
  ia_pausada: "A IA se pausou nesta conversa",
  passou_pra_humano: "A IA passou o atendimento pra vocês",
};

export function lerConfigAlerta(config: unknown): ConfigAlerta | null {
  const n = (config as { notifications?: { alerta_whatsapp?: ConfigAlerta } } | null)?.notifications;
  const a = n?.alerta_whatsapp;
  if (!a || a.enabled !== true) return null;
  return a;
}

/**
 * Dispara o aviso. NUNCA lança — é observabilidade, não pode derrubar o turno.
 */
export async function alertarAtendimento(args: Args): Promise<ResultadoAlerta> {
  try {
    const cfg = lerConfigAlerta(args.config);
    if (!cfg) return { enviado: false, motivo_skip: "desligado" };
    if (cfg.motivos && cfg.motivos.length > 0 && !cfg.motivos.includes(args.motivo)) {
      return { enviado: false, motivo_skip: "motivo_nao_assinado" };
    }
    const bruto = (cfg.phone || "").trim();
    if (!bruto) return { enviado: false, motivo_skip: "sem_telefone" };

    const supabase = createAdminClient();

    // O SparkBot endereça por rep_identities — telefone solto não tem pra onde ir.
    const telefone = normalizePhone(bruto, "US");
    const { data: rep } = await supabase
      .from("rep_identities")
      .select("id, phone, active_location_id, last_inbound_at")
      .eq("phone", telefone)
      .maybeSingle();
    if (!rep) {
      console.warn(`[alerta-atendimento] telefone ${telefone} não está em rep_identities — sem destino`);
      return { enviado: false, motivo_skip: "rep_nao_cadastrado" };
    }

    // ── anti-tempestade 1: mesmo (agente, contato, motivo) ──
    // Conta TENTATIVAS, não entregas. Se contasse só entrega, um destinatário
    // sem opt-in (que cai no painel, nunca no WhatsApp) nunca acionaria o
    // cooldown e cada evento viraria uma linha nova — spam no painel.
    const desdeCooldown = new Date(Date.now() - COOLDOWN_MIN * 60_000).toISOString();
    const { count: repetido } = await supabase
      .from("execution_log")
      .select("id", { count: "exact", head: true })
      .eq("agent_id", args.agentId)
      .eq("contact_id", args.contactId)
      .eq("action_type", "alerta_atendimento")
      .contains("action_payload", { motivo: args.motivo })
      .gte("created_at", desdeCooldown);
    if ((repetido ?? 0) > 0) return { enviado: false, motivo_skip: "cooldown" };

    // ── anti-tempestade 2: teto por hora na location ──
    const desdeHora = new Date(Date.now() - 60 * 60_000).toISOString();
    const { count: naHora } = await supabase
      .from("execution_log")
      .select("id", { count: "exact", head: true })
      .eq("location_id", args.locationId)
      .eq("action_type", "alerta_atendimento")
      .gte("created_at", desdeHora);
    if ((naHora ?? 0) >= TETO_HORA) {
      console.warn(`[alerta-atendimento] teto de ${TETO_HORA}/h atingido na location ${args.locationId}`);
      return { enviado: false, motivo_skip: "teto_hora" };
    }

    const quem = args.nomeContato?.trim() || "um contato";
    const texto =
      `⚠️ ${ROTULO[args.motivo]}\n\n` +
      `Contato: ${quem}\n` +
      `${args.detalhe}\n\n` +
      `Vale dar uma olhada na conversa quando puder.`;

    const { deliverProactiveMessage } = await import(
      "@/lib/account-assistant/proactive/whatsapp-delivery"
    );
    const dr = await deliverProactiveMessage(
      { id: rep.id, phone: rep.phone, last_inbound_at: rep.last_inbound_at },
      texto,
      {
        activeLocationId: rep.active_location_id || args.locationId,
        source: "alerta_atendimento",
        // Chave própria (H71): o default é `fonte:rep:minuto` e dois alertas
        // distintos no mesmo minuto viravam um só.
        dedupeKey: `alerta:${args.agentId}:${args.contactId}:${args.motivo}`,
      } as Parameters<typeof deliverProactiveMessage>[2],
    );

    // H71: `dr.ok` é true mesmo quando o WhatsApp NÃO saiu — inclusive no caso
    // de opt-in ausente, que cai no painel e ainda assim volta ok. Quem diz a
    // verdade é o `via`, e SÓ `whatsapp` significa que a pessoa foi avisada no
    // celular. Marcar `blocked_no_optin` como entregue registraria "avisei" pra
    // exatamente quem nunca vai receber.
    const via = (dr as { via?: string }).via || "";
    const noCelular = via === "whatsapp";

    await supabase.from("execution_log").insert({
      agent_id: args.agentId,
      location_id: args.locationId,
      contact_id: args.contactId,
      action_type: "alerta_atendimento",
      action_payload: {
        motivo: args.motivo,
        entregue: noCelular,
        via,
        rep_id: rep.id,
        detalhe: args.detalhe.slice(0, 200),
        // Sinaliza o caso "existe destinatário, mas ele nunca escreveu pro
        // SparkBot" — o aviso ficou só no badge do painel. É acionável: basta a
        // pessoa mandar um "oi" uma vez.
        so_no_painel: via === "blocked_no_optin",
      },
      success: noCelular,
    });

    return noCelular
      ? { enviado: true, via }
      : { enviado: false, motivo_skip: "entrega_falhou", via };
  } catch (err) {
    console.warn(
      "[alerta-atendimento] falhou (non-fatal):",
      err instanceof Error ? err.message : err,
    );
    return { enviado: false, motivo_skip: "entrega_falhou" };
  }
}
