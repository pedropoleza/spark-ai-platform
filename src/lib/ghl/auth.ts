import { createGHLTokenClient } from "@/lib/supabase/admin";
import { GHL_API_BASE, GHL_API_VERSION } from "@/lib/utils/constants";
import type { GHLTokenResponse } from "@/types/ghl";

// Cache de location tokens em memoria (por locationId)
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

/**
 * Busca o company token no Supabase (Token Refresher table)
 */
export async function getCompanyToken(companyId: string): Promise<{
  access_token: string;
  companyId: string;
}> {
  const supabase = createGHLTokenClient();

  const { data, error } = await supabase
    .from("Token Refresher")
    .select("*")
    .eq("companyId", companyId)
    .single();

  if (error || !data) {
    throw new Error(`Token nao encontrado para companyId: ${companyId}`);
  }

  return {
    access_token: data.access_token,
    companyId: data.companyId,
  };
}

/**
 * Gera um location token a partir do company token
 */
export async function getLocationToken(
  companyId: string,
  locationId: string
): Promise<string> {
  // Verificar cache
  const cacheKey = `${companyId}:${locationId}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.token;
  }

  // Buscar company token
  const companyToken = await getCompanyToken(companyId);

  // Gerar location token via GHL API
  const response = await fetch(`${GHL_API_BASE}/oauth/locationToken`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      Version: GHL_API_VERSION,
      Authorization: `Bearer ${companyToken.access_token}`,
    },
    body: new URLSearchParams({
      companyId,
      locationId,
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Falha ao gerar location token: ${response.status} - ${errorBody}`);
  }

  const data: GHLTokenResponse = await response.json();

  // Cachear por 20 minutos (token GHL expira em ~24h, mas renovamos com frequencia)
  tokenCache.set(cacheKey, {
    token: data.access_token,
    expiresAt: Date.now() + 20 * 60 * 1000,
  });

  return data.access_token;
}

/**
 * Invalida o cache de token para uma location
 */
export function invalidateTokenCache(companyId: string, locationId: string) {
  tokenCache.delete(`${companyId}:${locationId}`);
}
