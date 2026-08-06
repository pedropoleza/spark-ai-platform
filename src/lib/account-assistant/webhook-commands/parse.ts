/**
 * Parser do payload de "comando via webhook" — automações do Spark Leads
 * mandando ordem pro SparkBot (H71, Pedro 2026-08-05).
 *
 * Dois tipos de comando:
 *   - `notification`: manda a mensagem CRUA pro corretor (aviso da conta).
 *   - `prompt`:       roda o prompt no SparkBot e o que ELE responder vai
 *                     pro WhatsApp do corretor (proatividade sob comando).
 *
 * Por que um parser dedicado em vez de ler `body.x` direto: o mesmo dado
 * chega com nome diferente conforme ONDE a automação foi montada (ação
 * "Webhook" nativa, custom values, workflow importado). Em vez de obrigar o
 * Pedro a decorar a grafia exata, aceitamos as variantes conhecidas e
 * ERRAMOS EXPLÍCITO quando não dá pra decidir — nunca adivinhamos.
 *
 * Regra de ouro do destino (`send_to`): o payload de automação já traz
 * `phone` = telefone do LEAD. Se aceitássemos `phone` como destino, o aviso
 * do corretor iria pro cliente. Por isso `phone`/`contact_phone` são
 * IGNORADOS de propósito na resolução do destino — só campos explícitos.
 */

/** Tipos de comando aceitos. */
export type CommandKind = "notification" | "prompt";

export interface ParsedCommand {
  locationId: string;
  kind: CommandKind;
  /** Texto do aviso (notification) ou a instrução pro bot (prompt). */
  message: string;
  /** Telefone de destino, como veio (normalização acontece no authorize). */
  sendTo: string;
  /** Contato da automação — vira "CONTATO EM CONTEXTO" no modo prompt. */
  contactId: string | null;
  contactName: string | null;
  /** Chave de idempotência explícita, quando a automação mandar uma. */
  requestId: string | null;
  /** Segredo compartilhado, quando configurado. */
  secret: string | null;
}

export type ParseResult =
  | { ok: true; command: ParsedCommand }
  | { ok: false; reason: string; detail: string };

// ---------------------------------------------------------------------------
// Coerção defensiva
// ---------------------------------------------------------------------------

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/**
 * Merge field que o Spark Leads NÃO conseguiu resolver chega literal
 * (`{{contact.phone}}`). Tratar como valor válido faria o bot mandar aviso
 * pro telefone "{{...}}" — mesma classe do falso-positivo do F52. Vale como
 * ausência, e o erro diz exatamente isso pro Pedro consertar a automação.
 */
export function isMergeFieldNaoResolvido(valor: string): boolean {
  return /\{\{[^}]*\}\}/.test(valor);
}

/**
 * Onde procurar os campos. O `customData` é onde a ação "Webhook" do Spark
 * Leads coloca os campos customizados em algumas versões; em outras, tudo
 * vem na raiz. Varremos os dois (raiz primeiro).
 */
function escoposDeBusca(body: Record<string, unknown>): Record<string, unknown>[] {
  return [
    body,
    asRecord(body.customData),
    asRecord(body.custom_data),
    asRecord(body.data),
    asRecord(body.payload),
  ];
}

/**
 * Primeiro valor string não-vazio entre as chaves pedidas, varrendo todos os
 * escopos. Merge field não resolvido conta como ausente.
 */
function pick(body: Record<string, unknown>, ...chaves: string[]): string | null {
  for (const escopo of escoposDeBusca(body)) {
    for (const chave of chaves) {
      const v = escopo[chave];
      if (typeof v === "string") {
        const t = v.trim();
        if (t && !isMergeFieldNaoResolvido(t)) return t;
      } else if (typeof v === "number" && Number.isFinite(v)) {
        return String(v);
      }
    }
  }
  return null;
}

/** Normaliza pra comparação: minúsculo, sem acento, sem separador. */
function chaveNormalizada(valor: string): string {
  return valor
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
}

// ---------------------------------------------------------------------------
// Vocabulário aceito
// ---------------------------------------------------------------------------

/**
 * Sinônimos do tipo. Aceita PT e EN porque a automação é montada por humano
 * dentro do Spark Leads — quem escreve "aviso" quer dizer notification.
 */
const SINONIMOS_TIPO: Record<string, CommandKind> = {
  notification: "notification",
  notificacao: "notification",
  notify: "notification",
  aviso: "notification",
  alerta: "notification",
  alert: "notification",
  mensagem: "notification",
  message: "notification",
  prompt: "prompt",
  comando: "prompt",
  command: "prompt",
  instrucao: "prompt",
  instruction: "prompt",
  ia: "prompt",
  ai: "prompt",
};

const CAMPOS_TIPO = [
  "message_type",
  "messageType",
  "notification_type",
  "notificationType",
  "command_type",
  "commandType",
  "sparkbot_type",
  "tipo",
  // `type` fica por último: payload de automação às vezes já usa `type` pra
  // outra coisa. Como validamos o VALOR contra o vocabulário, um `type`
  // alheio não vira comando — cai no erro de tipo desconhecido.
  "type",
];

const CAMPOS_MENSAGEM = [
  "message",
  "mensagem",
  "text",
  "texto",
  "body",
  "content",
  "conteudo",
];

/** Só no modo prompt — evita que um `prompt` solto vire aviso cru. */
const CAMPOS_PROMPT = ["prompt", "comando", "instrucao", "instruction", "pergunta"];

/**
 * Destino. NÃO inclui `phone`/`contact_phone`/`contact.phone` de propósito:
 * esses são do LEAD no payload da automação (ver cabeçalho do arquivo).
 */
const CAMPOS_DESTINO = [
  "send_to",
  "sendTo",
  "send_to_phone",
  "sendToPhone",
  "to_phone",
  "toPhone",
  "rep_phone",
  "repPhone",
  "notify_phone",
  "notifyPhone",
  "destino",
  "telefone_destino",
  "numero_destino",
  "to",
];

const CAMPOS_LOCATION = ["location_id", "locationId", "locationID", "location"];

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

/** Extrai o location id — o Spark Leads manda como string ou objeto aninhado. */
export function extrairLocationId(body: Record<string, unknown>): string | null {
  for (const escopo of escoposDeBusca(body)) {
    for (const chave of CAMPOS_LOCATION) {
      const v = escopo[chave];
      if (typeof v === "string") {
        const t = v.trim();
        if (t && !isMergeFieldNaoResolvido(t)) return t;
      }
      // `location: { id, name }` — shape do webhook nativo.
      const obj = asRecord(v);
      const id = obj.id ?? obj.location_id ?? obj.locationId;
      if (typeof id === "string") {
        const t = id.trim();
        if (t && !isMergeFieldNaoResolvido(t)) return t;
      }
    }
  }
  return null;
}

function extrairNomeContato(body: Record<string, unknown>): string | null {
  const cheio = pick(body, "full_name", "fullName", "contact_name", "contactName", "name");
  if (cheio) return cheio;
  const primeiro = pick(body, "first_name", "firstName");
  const ultimo = pick(body, "last_name", "lastName");
  const junto = [primeiro, ultimo].filter(Boolean).join(" ").trim();
  return junto || null;
}

export function parseWebhookCommand(bodyRaw: unknown): ParseResult {
  const body = asRecord(bodyRaw);
  if (Object.keys(body).length === 0) {
    return { ok: false, reason: "payload_vazio", detail: "O corpo do webhook chegou vazio ou não é um JSON de objeto." };
  }

  const locationId = extrairLocationId(body);
  if (!locationId) {
    return {
      ok: false,
      reason: "location_ausente",
      detail:
        "Não achei o id da sub-conta no payload. A ação de webhook do Spark Leads normalmente já manda " +
        "`location.id`; se a sua não manda, adiciona um campo `location_id` no custom data.",
    };
  }

  const tipoBruto = pick(body, ...CAMPOS_TIPO);
  if (!tipoBruto) {
    return {
      ok: false,
      reason: "tipo_ausente",
      detail:
        "Faltou o tipo do comando. Adiciona um campo `message_type` no custom data com o valor " +
        "`notification` (mandar o texto como está) ou `prompt` (o SparkBot responde o comando).",
    };
  }
  const kind = SINONIMOS_TIPO[chaveNormalizada(tipoBruto)];
  if (!kind) {
    return {
      ok: false,
      reason: "tipo_desconhecido",
      detail: `Tipo "${tipoBruto}" não existe. Os valores aceitos são \`notification\` e \`prompt\`.`,
    };
  }

  // No modo prompt, `prompt`/`comando` têm precedência sobre `message` — quem
  // preencheu os dois quis dizer que o prompt é a instrução.
  const message =
    kind === "prompt"
      ? pick(body, ...CAMPOS_PROMPT, ...CAMPOS_MENSAGEM)
      : pick(body, ...CAMPOS_MENSAGEM);
  if (!message) {
    const campoEsperado = kind === "prompt" ? "`prompt` (ou `message`)" : "`message`";
    return {
      ok: false,
      reason: "mensagem_ausente",
      detail:
        `Faltou o texto do comando. Adiciona um campo ${campoEsperado} no custom data. ` +
        "Se o campo existe mas veio com `{{...}}` dentro, o merge field do Spark Leads não foi resolvido.",
    };
  }

  const sendTo = pick(body, ...CAMPOS_DESTINO);
  if (!sendTo) {
    return {
      ok: false,
      reason: "destino_ausente",
      detail:
        "Faltou o telefone de destino. Adiciona um campo `send_to` no custom data com o número do corretor " +
        "que deve receber. Repara que o campo `phone` do payload é o do LEAD — por segurança ele nunca é " +
        "usado como destino.",
    };
  }

  return {
    ok: true,
    command: {
      locationId,
      kind,
      message,
      sendTo,
      contactId: pick(body, "contact_id", "contactId", "contactID"),
      contactName: extrairNomeContato(body),
      requestId: pick(body, "request_id", "requestId", "event_id", "eventId", "idempotency_key", "webhook_id"),
      secret: pick(body, "secret", "spark_secret", "sparkSecret", "token"),
    },
  };
}
