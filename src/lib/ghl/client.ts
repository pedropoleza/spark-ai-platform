import { getLocationToken } from "./auth";
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

  async get<T>(path: string, params?: Record<string, string>): Promise<T> {
    const url = new URL(`${GHL_API_BASE}${path}`);
    if (params) {
      Object.entries(params).forEach(([key, value]) => {
        url.searchParams.set(key, value);
      });
    }

    const headers = await this.getHeaders();
    const response = await fetch(url.toString(), { headers });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`GHL API GET ${path} falhou: ${response.status} - ${errorBody}`);
    }

    return response.json();
  }

  async post<T>(path: string, body?: Record<string, unknown>): Promise<T> {
    const headers = await this.getHeaders();
    const response = await fetch(`${GHL_API_BASE}${path}`, {
      method: "POST",
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`GHL API POST ${path} falhou: ${response.status} - ${errorBody}`);
    }

    return response.json();
  }

  async put<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const headers = await this.getHeaders();
    const response = await fetch(`${GHL_API_BASE}${path}`, {
      method: "PUT",
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`GHL API PUT ${path} falhou: ${response.status} - ${errorBody}`);
    }

    return response.json();
  }

  async delete<T>(path: string, body?: Record<string, unknown>): Promise<T> {
    const headers = await this.getHeaders();
    const response = await fetch(`${GHL_API_BASE}${path}`, {
      method: "DELETE",
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`GHL API DELETE ${path} falhou: ${response.status} - ${errorBody}`);
    }

    return response.json();
  }
}
