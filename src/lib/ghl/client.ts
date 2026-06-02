import { getLocationToken, invalidateTokenCache } from "./auth";
import { GHL_API_BASE, GHL_API_VERSION } from "@/lib/utils/constants";

// F43 (Pedro 2026-06-02): teto duro por tentativa de fetch ao GHL. Backstop
// contra conexões penduradas (free-slots já travou 60s+ sem isso). Generoso
// o bastante pra não cortar call legítima — nenhuma REST do GHL leva 20s.
const GHL_FETCH_TIMEOUT_MS = 20_000;

export class GHLClient {
  private companyId: string;
  private locationId: string;

  constructor(companyId: string, locationId: string) {
    this.companyId = companyId;
    this.locationId = locationId;
  }

  private async getHeaders(): Promise<Record<string, string>> {
    const token = await getLocationToken(this.companyId, this.locationId);
    return {
      Authorization: `Bearer ${token}`,
      Version: GHL_API_VERSION,
      "Content-Type": "application/json",
      Accept: "application/json",
    };
  }

  private async retryOnAuth<T>(request: () => Promise<Response>): Promise<T> {
    let response: Response;
    // Retry envelope: até 2 tentativas extras em erros transitórios (network, 5xx).
    let attempt = 0;
    const maxTransientRetries = 2;
    while (true) {
      try {
        response = await request();
        break;
      } catch (err) {
        // Network error (fetch rejeitou antes de receber response)
        if (attempt >= maxTransientRetries) throw err;
        const delay = 200 * Math.pow(2, attempt);
        console.warn(`[GHL] Network error (attempt ${attempt + 1}), retrying in ${delay}ms: ${err instanceof Error ? err.message : err}`);
        await new Promise(r => setTimeout(r, delay));
        attempt++;
      }
    }

    // Se 401, invalidar cache e tentar com token novo
    if (response.status === 401) {
      console.warn(`[GHL] 401 received, invalidating token cache and retrying...`);
      invalidateTokenCache(this.companyId, this.locationId);
      response = await request();
      if (response.status === 401) {
        const body = await response.text();
        throw new Error(`GHL API 401 after token refresh: ${body}`);
      }
    }

    // Rate limit - wait and retry once
    if (response.status === 429) {
      const retryAfter = parseInt(response.headers.get("retry-after") || "5") * 1000;
      console.warn(`[GHL] 429 rate limited, waiting ${retryAfter}ms...`);
      await new Promise(r => setTimeout(r, retryAfter));
      response = await request();
    }

    // Fix Track 12 H3 (review 2026-05-05): 5xx com exponential backoff +
    // 2 retries (era só 1). Antes, GHL 502/503 transient quebrava a primeira
    // chamada do bot. Network errors já tinham 2 retries — alinhamos.
    //
    // Onda 2 (2026-05-20): IAM-unsupported é 5xx PERMANENTE (não transitório).
    // "This route is not yet supported by the IAM Service" → throw imediato,
    // sem retry. Antes: 3 chamadas desperdiçadas + latência por erro estrutural.
    if (response.status >= 500 && response.status < 600) {
      // Lê o body UMA vez pra checar IAM; clona clone pra não consumir o stream
      // principal (response.json() / response.text() downstream precisam dele).
      const bodyText = await response.text();
      if (/not yet supported by the IAM|not supported by the IAM|IAM Service/i.test(bodyText)) {
        // Erro permanente de escopo/IAM — não retenta, joga pro ghlErrorToResult.
        throw new Error(`GHL API ${response.status}: ${bodyText}`);
      }
      // Para os demais 5xx transitórios, reconstrói uma Response com o body lido
      // pra o loop de retry continuar normalmente (não podemos reler o stream).
      response = new Response(bodyText, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
      for (let attempt5xx = 0; attempt5xx < 2; attempt5xx++) {
        const delay = 300 * Math.pow(2, attempt5xx); // 300ms, 600ms
        console.warn(`[GHL] ${response.status} (attempt ${attempt5xx + 1}/2), retrying in ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
        response = await request();
        if (response.status < 500 || response.status >= 600) break;
      }
    }

    if (!response.ok) {
      const errorBody = await response.text();
      // Limite maior pra debug — 422 precisa do body pra saber qual campo falhou
      throw new Error(`GHL API ${response.status}: ${errorBody.substring(0, 800)}`);
    }

    return response.json();
  }

  /**
   * fetch com timeout duro via AbortController (Pedro 2026-06-02, F43).
   *
   * Bug observado em prod: free-slots (e outras calls GHL) podem PENDURAR
   * ~60s sem timeout. Combinado com retryOnAuth (3×) + withRetry no caller
   * (3×), o test chat travou 130s no "digitando..." (a IA levou 2,7s; o resto
   * foi a chamada de slots pendurada). Nenhuma call REST do GHL deve passar
   * de ~20s — o AbortController garante que uma conexão presa vire AbortError
   * (tratado como erro de rede pelo retryOnAuth) em vez de bloquear pra sempre.
   */
  private async fetchWithTimeout(
    input: string,
    init: RequestInit = {},
    timeoutMs = GHL_FETCH_TIMEOUT_MS,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(input, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  async get<T>(path: string, params?: Record<string, string>): Promise<T> {
    const url = new URL(`${GHL_API_BASE}${path}`);
    if (params) {
      Object.entries(params).forEach(([key, value]) => {
        url.searchParams.set(key, value);
      });
    }

    return this.retryOnAuth<T>(async () => {
      const headers = await this.getHeaders();
      return this.fetchWithTimeout(url.toString(), { headers });
    });
  }

  async post<T>(path: string, body?: Record<string, unknown>): Promise<T> {
    return this.retryOnAuth<T>(async () => {
      const headers = await this.getHeaders();
      return this.fetchWithTimeout(`${GHL_API_BASE}${path}`, {
        method: "POST",
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });
    });
  }

  async put<T>(path: string, body: Record<string, unknown>): Promise<T> {
    return this.retryOnAuth<T>(async () => {
      const headers = await this.getHeaders();
      return this.fetchWithTimeout(`${GHL_API_BASE}${path}`, {
        method: "PUT",
        headers,
        body: JSON.stringify(body),
      });
    });
  }

  async delete<T>(path: string, body?: Record<string, unknown>): Promise<T> {
    return this.retryOnAuth<T>(async () => {
      const headers = await this.getHeaders();
      return this.fetchWithTimeout(`${GHL_API_BASE}${path}`, {
        method: "DELETE",
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });
    });
  }
}
