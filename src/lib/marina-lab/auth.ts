/**
 * Auth do Marina Lab (temporário — ver `_planning/marina-lab/PLANO.md`).
 *
 * É uma senha só, pra UMA pessoa, por alguns dias. Sem tabela de usuário e sem
 * fluxo de recuperação de propósito: a superfície inteira morre com
 * MARINA_LAB_ENABLED=0, sem deploy.
 *
 * O agente e a location vêm do TOKEN, nunca do body — é o que impede a senha da
 * Marina de virar chave pra testar agente de outra conta.
 */
import { SignJWT, jwtVerify } from "jose";
import type { NextRequest } from "next/server";

export const MARINA_COOKIE = "marina_lab";
const TTL_DIAS = 7;

/** Agente de pós-atendimento da Marina + a Personal account onde ele vive. */
export const MARINA_AGENT_ID = "d4894e2a-43fa-4b2f-8949-0bbd941be2b9";
export const MARINA_LOCATION_ID = "ONRf1DUKVnfxivEGxcTj";
export const MARINA_COMPANY_ID = "TdmQMjj86Y3LgppiB96K";

export interface MarinaToken {
  scope: "marina-lab";
  agent_id: string;
  location_id: string;
  company_id: string;
}

function segredo(): Uint8Array {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error("JWT_SECRET não configurado");
  return new TextEncoder().encode(s);
}

export function marinaLabLigado(): boolean {
  // Default LIGADO: a página é o entregável; desligar é ato explícito.
  return (process.env.MARINA_LAB_ENABLED || "1").trim() !== "0";
}

/** Comparação de tempo constante (mesmo padrão do H71). */
function senhaConfere(recebida: string, esperada: string): boolean {
  if (recebida.length !== esperada.length) return false;
  let dif = 0;
  for (let i = 0; i < recebida.length; i++) dif |= recebida.charCodeAt(i) ^ esperada.charCodeAt(i);
  return dif === 0;
}

export function validarSenha(senha: string): boolean {
  const esperada = (process.env.MARINA_LAB_PASSWORD || "").trim();
  // Fail-CLOSED: sem senha configurada, ninguém entra (o contrário viraria
  // página aberta na internet).
  if (!esperada) return false;
  return senhaConfere(senha.trim(), esperada);
}

export async function assinarTokenMarina(): Promise<string> {
  const payload: MarinaToken = {
    scope: "marina-lab",
    agent_id: MARINA_AGENT_ID,
    location_id: MARINA_LOCATION_ID,
    company_id: MARINA_COMPANY_ID,
  };
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${TTL_DIAS}d`)
    .sign(segredo());
}

/** Lê o cookie e valida. `null` = não autenticada (ou lab desligado). */
export async function lerTokenMarina(request: NextRequest): Promise<MarinaToken | null> {
  if (!marinaLabLigado()) return null;
  const raw = request.cookies.get(MARINA_COOKIE)?.value;
  if (!raw) return null;
  try {
    const { payload } = await jwtVerify(raw, segredo());
    if (payload.scope !== "marina-lab") return null;
    return {
      scope: "marina-lab",
      agent_id: String(payload.agent_id),
      location_id: String(payload.location_id),
      company_id: String(payload.company_id),
    };
  } catch {
    return null;
  }
}
