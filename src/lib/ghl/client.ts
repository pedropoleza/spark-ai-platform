import { getLocationToken, invalidateTokenCache } from "./auth";
import { GHL_API_BASE, GHL_API_VERSION } from "@/lib/utils/constants";

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
    let response = await request();

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

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`GHL API ${response.status}: ${errorBody.substring(0, 200)}`);
    }

    return response.json();
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
      return fetch(url.toString(), { headers });
    });
  }

  async post<T>(path: string, body?: Record<string, unknown>): Promise<T> {
    return this.retryOnAuth<T>(async () => {
      const headers = await this.getHeaders();
      return fetch(`${GHL_API_BASE}${path}`, {
        method: "POST",
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });
    });
  }

  async put<T>(path: string, body: Record<string, unknown>): Promise<T> {
    return this.retryOnAuth<T>(async () => {
      const headers = await this.getHeaders();
      return fetch(`${GHL_API_BASE}${path}`, {
        method: "PUT",
        headers,
        body: JSON.stringify(body),
      });
    });
  }

  async delete<T>(path: string, body?: Record<string, unknown>): Promise<T> {
    return this.retryOnAuth<T>(async () => {
      const headers = await this.getHeaders();
      return fetch(`${GHL_API_BASE}${path}`, {
        method: "DELETE",
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });
    });
  }
}
