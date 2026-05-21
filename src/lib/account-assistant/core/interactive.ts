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

  // Regra de auto-escolha (refinada no caso 15:34: 3 calendários de nome longo
  // viraram texto). Não é só pelo NÚMERO: usa LISTA quando 4+ opções OU rótulo
  // longo (>20 chars, estoura o botão) OU quando uma descrição ajuda
  // (telefone/email/data). Botão só pra ≤3 opções curtas e sem descrição.
  const style = String(input.style || "auto").toLowerCase();
  const needsList =
    options.length > 3 ||
    options.some((o) => o.label.length > 20 || !!o.description);
  const kind: "buttons" | "list" =
    style === "buttons" ? "buttons" : style === "list" ? "list" : needsList ? "list" : "buttons";

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

/**
 * BACKSTOP determinístico (Pedro 2026-05-20): se o LLM ESQUECEU de chamar
 * present_options e escreveu uma lista NUMERADA com cue de escolha, converte
 * pra payload interativo. Garante adoção mesmo sem adesão 100% do modelo.
 *
 * Retorna null (não converte) quando:
 *  - não há ≥2 itens numerados, OU
 *  - não há cue de escolha (qual/escolhe/prefere/opção OU termina com "?") —
 *    pra não transformar lista INFORMATIVA ("fiz 3 coisas: 1…2…") em menu.
 */
export function detectNumberedOptionsFallback(text: string): InteractivePayload | null {
  if (!text) return null;
  const lines = text.split(/\r?\n/);
  const opts: { idx: number; label: string }[] = [];
  lines.forEach((line, idx) => {
    const m = line.match(/^\s*(\d+)[.)]\s+(.+\S)\s*$/);
    if (m) opts.push({ idx, label: m[2].replace(/\*/g, "").trim() });
  });
  if (opts.length < 2) return null;

  const lower = text.toLowerCase();
  const hasCue =
    /(qual|quais|escolh|prefere|prefer[ie]|\bop[çc]|qual deles|qual dos|sim ou n[ãa]o)/.test(lower) ||
    text.trim().endsWith("?");
  if (!hasCue) return null;

  const firstIdx = opts[0].idx;
  const lastIdx = opts[opts.length - 1].idx;
  let body = lines.slice(0, firstIdx).join("\n").replace(/\*/g, "").trim();
  if (!body) body = lines.slice(lastIdx + 1).join(" ").replace(/\*/g, "").trim();
  if (!body) body = "Escolhe uma opção:";

  const options: InteractiveOption[] = opts.map((o, i) => ({
    id: `opt_${i + 1}`,
    label: o.label.slice(0, 72),
  }));
  const needsList = options.length > 3 || options.some((o) => o.label.length > 20);
  return { kind: needsList ? "list" : "buttons", body, options };
}
