/**
 * Auth do Alves Lab (temporário — pedido do Pedro 2026-08-31, pós-pacote H88).
 *
 * Mesmo desenho do Marina Lab (`_planning/marina-lab/PLANO.md`): PIN de 4
 * dígitos em env, cookie httpOnly, kill-switch sem deploy. É pro Marcos e time
 * testarem a Bruna e o Bruno reformados ANTES da religa — nada aqui fala com
 * lead nenhum.
 *
 * Os agentes e a location vêm do TOKEN, nunca do body — o PIN do Marcos não
 * vira chave pra testar agente de outra conta.
 */
import { SignJWT, jwtVerify } from "jose";
import type { NextRequest } from "next/server";

export const ALVES_COOKIE = "alves_lab";
const TTL_DIAS = 14;

/** Os dois agentes da Alves Cury Financial + a location deles. */
export const ALVES_BRUNA_ID = "e698f2b4-92bf-4c6a-9429-dc18ab94096b";
export const ALVES_BRUNO_ID = "a0339877-7096-4384-a2d8-34d9daedb339";
export const ALVES_AGENT_IDS = [ALVES_BRUNA_ID, ALVES_BRUNO_ID] as const;
export const ALVES_LOCATION_ID = "YuR0LCZomFzrfkDK2ezo";
export const ALVES_COMPANY_ID = "TdmQMjj86Y3LgppiB96K";

export interface AlvesToken {
  scope: "alves-lab";
  agent_ids: string[];
  location_id: string;
  company_id: string;
}

function segredo(): Uint8Array {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error("JWT_SECRET não configurado");
  return new TextEncoder().encode(s);
}

export function alvesLabLigado(): boolean {
  // Default LIGADO: a página é o entregável; desligar é ato explícito.
  return (process.env.ALVES_LAB_ENABLED || "1").trim() !== "0";
}

/** Comparação de tempo constante (mesmo padrão do H71/Marina Lab). */
function pinConfere(recebido: string, esperado: string): boolean {
  if (recebido.length !== esperado.length) return false;
  let dif = 0;
  for (let i = 0; i < recebido.length; i++) dif |= recebido.charCodeAt(i) ^ esperado.charCodeAt(i);
  return dif === 0;
}

export function validarPin(pin: string): boolean {
  const esperado = (process.env.ALVES_LAB_PIN || "").trim();
  // Fail-CLOSED: sem PIN configurado, ninguém entra.
  if (!esperado) return false;
  return pinConfere(pin.replace(/\D/g, ""), esperado);
}

export async function assinarTokenAlves(): Promise<string> {
  const payload: AlvesToken = {
    scope: "alves-lab",
    agent_ids: [...ALVES_AGENT_IDS],
    location_id: ALVES_LOCATION_ID,
    company_id: ALVES_COMPANY_ID,
  };
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${TTL_DIAS}d`)
    .sign(segredo());
}

/** Lê o cookie e valida. `null` = não autenticado (ou lab desligado). */
export async function lerTokenAlves(request: NextRequest): Promise<AlvesToken | null> {
  if (!alvesLabLigado()) return null;
  const raw = request.cookies.get(ALVES_COOKIE)?.value;
  if (!raw) return null;
  try {
    const { payload } = await jwtVerify(raw, segredo());
    if (payload.scope !== "alves-lab") return null;
    const ids = Array.isArray(payload.agent_ids) ? payload.agent_ids.map(String) : [];
    if (ids.length === 0) return null;
    return {
      scope: "alves-lab",
      agent_ids: ids,
      location_id: String(payload.location_id),
      company_id: String(payload.company_id),
    };
  } catch {
    return null;
  }
}
