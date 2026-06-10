/**
 * Worker-pool genérico: roda `fn` sobre `items` com no máximo `limit` em voo.
 *
 * Preserva ordem (results[i] ↔ items[i]) e NÃO engole erro — a semântica de
 * falha parcial é responsabilidade do `fn`. O padrão no codebase é o `fn`
 * fazer `try/catch` e devolver um resultado discriminado (`{ ok: false }`), de
 * modo que o pool nunca rejeite e a falha de um item não derrube os outros
 * (equivalente a Promise.allSettled, mas com refil contínuo do pool em vez de
 * barreira por lote).
 *
 * Capar a concorrência evita thundering-herd no mutex de token do GHL
 * (lib/ghl/auth.ts): dezenas de requests paralelas degradam pra batches
 * sequenciais em vez de estourar tudo de uma vez. Usado pelo fan-out de calls
 * GHL do polling post_meeting (cron/sparkbot-proactive, H39).
 *
 * NOTA (dedupe pendente): `tools/calendar.ts` tem uma cópia local idêntica
 * (H36) — não unificada agora pra não tocar num arquivo com mudanças não
 * relacionadas em voo. Quando for, é só apagar a cópia de lá e importar daqui.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  // JS é single-thread: `cursor++` não cruza await, então leitura+incremento é
  // atômica entre os workers — sem race no índice.
  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i], i);
    }
  };
  const poolSize = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: poolSize }, () => worker()));
  return results;
}
