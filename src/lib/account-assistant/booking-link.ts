/**
 * Link público de agendamento do calendário (review de uso 2026-08-25).
 *
 * O PEDIDO: "me dá meu link de agendamento pra eu passar pra cliente" foi o
 * pedido mais repetido do período (Paulo Abreu 2×, Danielle Velho 1×).
 *
 * O QUE ACONTECIA: o bot não tinha a capacidade e reagia de duas formas — às
 * vezes recusava honestamente ("o Spark Leads não expõe o link por aqui"), e
 * uma vez **inventou**: mandou `link.sparklaunch.io/widget/bookings/
 * consulta-inicial-drabreu` como se fosse o link real do Paulo e ofereceu
 * disparar pro Pr Otto Fanini. O Paulo testou, não abriu, e o bot admitiu que
 * "o link que eu gerei foi um exemplo genérico". Só não foi pro prospect
 * porque o rep conferiu. A inconsistência é o perigo: às vezes recusa, às
 * vezes alucina.
 *
 * O QUE FOI APURADO CONTRA A API DE PRODUÇÃO (8 locations, 24 calendários):
 *  1. `GET /calendars/` já devolve `widgetSlug` — o slug do Paulo na API é
 *     exatamente o `consulta-inicial-drabreu` da URL que ele colou. O dado
 *     sempre esteve lá.
 *  2. As duas formas de URL resolvem em 100% dos calendários testados:
 *       <base>/widget/booking/<calendarId>     ← usamos esta
 *       <base>/widget/bookings/<widgetSlug>
 *  3. Slug/ID inexistente devolve **JSON 404 explícito** (não uma SPA vazia),
 *     então dá pra VALIDAR o link antes de entregar.
 *
 * POR QUE O ID E NÃO O SLUG: o id é imutável; o slug é editável pelo dono da
 * conta (link morre em silêncio) e às vezes é sopa de UUID de 100+ chars
 * ("field-training-026ff66d-d082-482a-99f9-...-11ae70eb-66a0-40fc-8679-..."),
 * que ninguém manda pra cliente. O slug fica como alternativa quando é curto.
 *
 * A base é env (`SPARK_BOOKING_BASE_URL`) porque é o domínio white-label da
 * agência, não um dado da location — `GET /locations/{id}.domain` vem vazio.
 */

/** Domínio do widget de agendamento. Configurável; default = o de produção. */
export function getBookingBaseUrl(): string {
  const raw = process.env.SPARK_BOOKING_BASE_URL?.trim();
  const base = raw || "https://internal.sparkleads.pro";
  return base.replace(/\/+$/, "");
}

/** Slug feio demais pra mandar pra cliente (UUID soup) → prefere o id. */
const SLUG_MAX_LEGIVEL = 60;

export interface BookingLinkCandidato {
  url: string;
  tipo: "id" | "slug";
}

/**
 * Monta os candidatos de URL pra um calendário, em ordem de preferência.
 * Puro (sem I/O) — a validação fica no `validarBookingLink`.
 */
export function montarBookingLinks(
  calendarId: string,
  widgetSlug?: string | null,
): BookingLinkCandidato[] {
  const base = getBookingBaseUrl();
  const out: BookingLinkCandidato[] = [];
  if (calendarId) out.push({ url: `${base}/widget/booking/${encodeURIComponent(calendarId)}`, tipo: "id" });
  const slug = (widgetSlug || "").trim();
  if (slug && slug.length <= SLUG_MAX_LEGIVEL) {
    out.push({ url: `${base}/widget/bookings/${encodeURIComponent(slug)}`, tipo: "slug" });
  }
  return out;
}

/**
 * O link abre mesmo? Distingue a página real do 404.
 *
 * O widget devolve HTML quando existe e um JSON `{"statusCode":404,...}` quando
 * não — medido em prod. Sem essa checagem a gente cairia no mesmo problema que
 * está resolvendo: entregar um link plausível que não abre.
 *
 * Fail-soft com significado: erro de rede devolve `null` (indeterminado), e o
 * caller trata como "não consegui confirmar" — nunca como "está bom".
 */
export async function validarBookingLink(
  url: string,
  timeoutMs = 6000,
): Promise<boolean | null> {
  try {
    const r = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "User-Agent": "SparkBot-LinkCheck/1.0" },
    });
    const head = (await r.text()).slice(0, 400);
    if (/"statusCode"\s*:\s*404|Page Not Found/i.test(head)) return false;
    if (!r.ok) return false;
    return /<!DOCTYPE html|<html/i.test(head);
  } catch {
    return null;
  }
}
