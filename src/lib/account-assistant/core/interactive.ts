/**
 * Camada de "apresentação interativa" (botões/listas do Stevo).
 *
 * Pedro 2026-05-20: o bot pode apresentar opções/confirmação pro rep TOCAR em
 * vez de digitar. O LLM sinaliza isso chamando a tool `present_options`; aqui
 * extraímos esse payload das tool calls e geramos o **texto-fallback** (corpo +
 * opções numeradas) usado nos canais sem interativo (web/GHL) e quando o envio
 * interativo falha. Mantém a saída do bot canal-agnóstica: o `stevo-handler`
 * decide renderizar como botão/lista (WhatsApp) ou texto.
 */

export interface InteractiveOption {
  /** ID estável que volta no tap (selectedButtonID / selectedRowID). */
  id: string;
  /** Texto visível do botão/row. */
  label: string;
  /** Descrição opcional (só lista). */
  description?: string;
}

export interface InteractivePayload {
  kind: "buttons" | "list";
  /** Corpo/pergunta (deve ser auto-contido — todo o texto user-facing). */
  body: string;
  options: InteractiveOption[];
  /** Header opcional. */
  title?: string;
  /** Footer opcional. */
  footer?: string;
  /** Label do botão que abre a lista (só `kind:"list"`). */
  buttonText?: string;
}

type ToolCallLike = { name: string; input: Record<string, unknown>; result?: unknown };

/**
 * Extrai o payload interativo da ÚLTIMA chamada `present_options` nas tool
 * calls do turno (a apresentação é terminal). Retorna null se não houve, ou se
 * faltarem body/opções válidas. Decide buttons vs list pelo nº de opções
 * (≤3 = buttons, 4+ = list), com override opcional via `style`.
 */
export function extractInteractiveFromToolCalls(
  toolCalls: ToolCallLike[],
): InteractivePayload | null {
  const calls = (toolCalls || []).filter((tc) => tc.name === "present_options");
  if (calls.length === 0) return null;

  const input = calls[calls.length - 1].input || {};
  const body = String(input.body || "").trim();
  const rawOptions = Array.isArray(input.options) ? input.options : [];
  const options: InteractiveOption[] = rawOptions
    .map((o) => {
      const r = (o || {}) as Record<string, unknown>;
      return {
        id: String(r.id || "").trim(),
        label: String(r.label || "").trim(),
        description: r.description ? String(r.description).trim() : undefined,
      };
    })
    .filter((o) => o.id && o.label);

  if (!body || options.length < 1) return null;

  const style = String(input.style || "auto").toLowerCase();
  const kind: "buttons" | "list" =
    style === "buttons"
      ? "buttons"
      : style === "list"
        ? "list"
        : options.length <= 3
          ? "buttons"
          : "list";

  const title = input.title ? String(input.title).trim() : undefined;
  const footer = input.footer ? String(input.footer).trim() : undefined;
  const buttonText = input.button_text ? String(input.button_text).trim() : undefined;

  return { kind, body, options, title, footer, buttonText };
}

/**
 * Texto-fallback pra canais sem interativo: header (se houver) + corpo +
 * opções numeradas. É o que o rep vê no painel web / GHL, e o que persiste em
 * sparkbot_messages.content (audit + histórico legível pro próximo turno).
 */
export function interactiveFallbackText(p: InteractivePayload): string {
  const lines = p.options.map(
    (o, i) => `${i + 1}. ${o.label}${o.description ? ` — ${o.description}` : ""}`,
  );
  const parts: string[] = [];
  if (p.title) parts.push(`*${p.title}*`);
  parts.push(p.body);
  parts.push(lines.join("\n"));
  return parts.join("\n\n").trim();
}
