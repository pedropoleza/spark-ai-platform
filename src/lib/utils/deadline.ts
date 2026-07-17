/**
 * withDeadline — corrida entre uma promise e um teto de tempo (ultra-review
 * 2026-07-17, casos Luciano/Fabiana: uma ÚNICA tool lenta estourava o orçamento
 * do turno POR DENTRO e a lambda morria muda no hard-limit de 60s da Vercel).
 *
 * JS não tem cancelamento de promise: estourar o deadline NÃO aborta o trabalho
 * subjacente — apenas devolve o controle pra quem chamou responder um fallback
 * honesto ANTES do hard-limit. Por isso a mensagem ao rep deve mandar CONFERIR
 * o estado, nunca repetir a ação às cegas (ela pode ter concluído depois).
 */
export class DeadlineExceededError extends Error {
  constructor(
    public readonly ms: number,
    label?: string,
  ) {
    super(`deadline de ${ms}ms excedido${label ? ` em ${label}` : ""}`);
    this.name = "DeadlineExceededError";
  }
}

export async function withDeadline<T>(
  p: Promise<T>,
  ms: number,
  label?: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new DeadlineExceededError(ms, label)), ms);
      }),
    ]);
  } finally {
    // Sempre limpa o timer — um setTimeout vivo segura a lambda desnecessariamente.
    if (timer) clearTimeout(timer);
  }
}
