/**
 * Variator pra disparo em massa do SparkBot.
 *
 * Pra cada recipient de um bulk_message_job, gera uma variação do template
 * pra parecer mais humano e evitar pattern detection do WhatsApp (que
 * banuje contas que mandam mesma msg pra 100 contatos seguidos).
 *
 * Modes:
 *   - 'none'   → retorna template direto, só interpola {first_name}
 *   - 'light'  → Haiku rewrite leve (oi/olá, ordem, sutilezas) — DEFAULT
 *   - 'medium' → Haiku parafraseia mais agressivamente (mantém sentido)
 *
 * Custo: Haiku ~$0.001/1k input + $0.005/1k output. Pra mensagem ~50
 * tokens IN + ~50 OUT = ~$0.0003 por variation. 100 contatos = $0.03.
 *
 * Fallback: se Haiku falhar, retorna template direto (não bloqueia envio).
 */

const VARIATION_SYSTEM_PROMPTS: Record<"light" | "medium", string> = {
  light: `Você é um assistente que reescreve mensagens curtas pra ficarem MAIS naturais e variadas, mantendo o significado IDÊNTICO.

Faça mudanças LEVES:
- Trocar saudação (oi/olá/e aí, mas só se já tiver uma)
- Mudar ordem de uma frase ou outra
- Trocar 1-2 palavras por sinônimos casuais
- NUNCA invente informação nova
- NUNCA mude nomes próprios, links, números, datas
- NUNCA adicione/remova chamadas pra ação
- Mantém o MESMO tom (formal/informal igual ao original)
- Mantém TAMANHO similar (não estende nem encurta drasticamente)

Retorne APENAS a mensagem reescrita, sem aspas, sem comentário, sem cabeçalho.`,

  medium: `Você é um assistente que reescreve mensagens curtas, parafraseando mais agressivamente mas mantendo o significado IDÊNTICO.

- Pode reorganizar frases, trocar várias palavras
- Mantém TODA informação factual (nomes, datas, links, números)
- Não adiciona/remove call-to-action
- Mantém tom (formal/informal) e tamanho similar

Retorne APENAS a mensagem reescrita, sem aspas, sem comentário.`,
};

/**
 * Interpola placeholders simples no template.
 * Suporta: {first_name}, {name}, {full_name}.
 * Se contactName for null/empty, remove o placeholder limpo (sem deixar
 * "Olá ," sobrando).
 */
export function interpolateTemplate(
  template: string,
  contactName: string | null | undefined,
): string {
  const name = (contactName || "").trim();
  if (!name) {
    // Remove placeholders + vírgula/espaço extra que possa sobrar
    return template
      .replace(/,?\s*\{(first_name|name|full_name)\}/g, "")
      .replace(/\{(first_name|name|full_name)\}/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }
  const firstName = name.split(/\s+/)[0];
  return template
    .replace(/\{first_name\}/g, firstName)
    .replace(/\{full_name\}/g, name)
    .replace(/\{name\}/g, firstName); // {name} = first_name por convenção
}

/**
 * Gera variação da mensagem pra um recipient específico.
 * Sempre retorna string não-vazia. Em erro, devolve interpolated direto.
 */
export async function generateVariation(
  template: string,
  mode: "none" | "light" | "medium",
  contactName: string | null | undefined,
): Promise<string> {
  const interpolated = interpolateTemplate(template, contactName);
  if (mode === "none") return interpolated;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.warn("[bulk-variator] ANTHROPIC_API_KEY ausente — retornando template direto");
    return interpolated;
  }

  try {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey, timeout: 30000, maxRetries: 2 });
    const systemPrompt = VARIATION_SYSTEM_PROMPTS[mode];

    const response = await client.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 500,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } } as any],
      messages: [
        {
          role: "user",
          content: `Mensagem original:\n${interpolated}\n\nReescreva mantendo o significado idêntico.`,
        },
      ],
      temperature: 0.7, // mais variedade que tool-use (que usa 0.3)
    });

    const textBlock = response.content.find((c) => c.type === "text");
    const variant = textBlock && "text" in textBlock ? textBlock.text.trim() : "";
    if (!variant) return interpolated;

    // Sanity check: variation não deve ser drasticamente diferente
    // em tamanho. Se veio menos de 30% ou mais de 200%, fallback.
    const ratio = variant.length / Math.max(interpolated.length, 1);
    if (ratio < 0.3 || ratio > 2.0) {
      console.warn(
        `[bulk-variator] variation tamanho suspeito (${variant.length} vs ${interpolated.length} chars) — usando original`,
      );
      return interpolated;
    }

    return variant;
  } catch (err) {
    console.warn(
      "[bulk-variator] Haiku falhou, retornando template direto:",
      err instanceof Error ? err.message : err,
    );
    return interpolated;
  }
}

/**
 * Gera N variações pra preview (UI). Roda em paralelo, retorna até `n`.
 * Pra mode='none', retorna [interpolated] (só 1, sem variar).
 */
export async function generatePreviewVariations(
  template: string,
  mode: "none" | "light" | "medium",
  exampleContactNames: string[],
  n: number = 2,
): Promise<string[]> {
  if (mode === "none") {
    return [interpolateTemplate(template, exampleContactNames[0] || null)];
  }
  const names = exampleContactNames.slice(0, n);
  while (names.length < n) names.push(""); // padding pra não-named
  const variations = await Promise.all(
    names.map((name) => generateVariation(template, mode, name)),
  );
  // De-duplica por hash simples (case-insensitive trimmed)
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const v of variations) {
    const key = v.toLowerCase().replace(/\s+/g, " ").trim();
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(v);
    }
  }
  return unique;
}
