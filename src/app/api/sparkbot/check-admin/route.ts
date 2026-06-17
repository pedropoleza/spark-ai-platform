/**
 * POST /api/sparkbot/check-admin
 *
 * Endpoint chamado pelo loader.js (Custom JS no GHL) pra:
 *   1. Validar que o user_id do GHL é admin (location ou agency)
 *   2. Encontrar/criar rep_identity correspondente
 *   3. Emitir JWT temporário (1h) que o painel web usa em chamadas seguintes
 *
 * Body: { userId: string, locationId: string, companyId: string }
 * Resposta sucesso (200):
 *   { ok: true, token: string, rep: { id, name, terms_accepted } }
 * Resposta não-admin (403):
 *   { ok: false, reason: "not_admin" }
 *
 * CORS: liberado pra qualquer origin GHL (app.gohighlevel.com, app.sparkleads.pro,
 * domínios white-label do agency). Em produção, restringir lista se quisermos.
 *
 * NOTA (2026-06-04): a verificação do idToken Firebase (RS256 via JWKS) foi
 * extraída pra @/lib/auth/ghl-idtoken (reuso no /api/agents/ui-auth dos controles
 * de UI). Mesma lógica security-reviewed (C3 2026-04-29), só movida.
 */

import { NextRequest, NextResponse } from "next/server";
import { validateGHLUser, upsertLocation } from "@/lib/auth/sso";
import { identifyRepByGhlUser } from "@/lib/account-assistant/identity";
import { signSparkbotWebToken } from "@/lib/account-assistant/web-auth";
import { corsHeadersFor } from "@/lib/utils/cors";
import { verifyFirebaseIdToken, isAdminClaims } from "@/lib/auth/ghl-idtoken";
import { isLocationSparkbotEnabled } from "@/lib/account-assistant/hub-resolver";
import { reportError } from "@/lib/admin-signals/report-error";

export const maxDuration = 30;

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, {
    status: 204,
    headers: corsHeadersFor(request, "POST, OPTIONS"),
  });
}

export async function POST(request: NextRequest) {
  const corsHeaders = corsHeadersFor(request, "POST, OPTIONS");
  const json = (data: Record<string, unknown>, init: ResponseInit = {}) =>
    NextResponse.json(data, { ...init, headers: { ...corsHeaders, ...(init.headers || {}) } });

  try {
    const body = await request.json();
    const userId: string = String(body.userId || "").trim();
    const locationId: string = String(body.locationId || "").trim();
    const companyId: string = String(body.companyId || "").trim();
    const locationName: string | undefined = body.locationName ? String(body.locationName) : undefined;
    const timezone: string | undefined = body.timezone ? String(body.timezone) : undefined;

    if (!userId || !locationId || !companyId) {
      return json({ ok: false, reason: "missing_params" }, { status: 400 });
    }

    // Gate de visibilidade (Pedro 2026-06-05): o widget do SparkBot só aparece
    // em locations que TÊM o app instalado (= agente account_assistant ATIVO).
    // O loader é injetado no nível da AGÊNCIA → carrega em TODAS as locations;
    // sem esse gate o widget vazava pra qualquer location onde o user fosse
    // admin. Retorna no_app (loader vê !data.ok → não injeta o botão). Checado
    // ANTES da validação de admin (mais barato: evita as chamadas GHL nas
    // locations sem o app).
    if (!(await isLocationSparkbotEnabled(locationId))) {
      return json({ ok: false, reason: "no_app" });
    }

    // Garante que a location existe (pra Sparkbot poder operar nela)
    try {
      await upsertLocation(locationId, companyId, locationName, timezone);
    } catch (err) {
      // Não bloqueia — location já pode existir; valida via GHL ainda
      console.warn("[check-admin] upsertLocation falhou (não-fatal):", err instanceof Error ? err.message : err);
    }

    // Validação multi-fonte (em ordem):
    //   1. idToken Firebase (JWT do GHL/sparkleads localStorage.refreshedToken)
    //      → verificado RS256 contra Firebase JWKS público. Assinatura
    //      válida = JWT emitido pelo Identity Toolkit pra um user REAL do
    //      Firebase Auth do GHL. Claims confiáveis (role, type, etc).
    //   2. Allowlist por env (agency admins).
    //   3. GHL API (/users/?locationId=...) — fallback pra users
    //      location-level que não estão como agency-admin.
    //
    // Histórico (review 2026-04-29 C3):
    // Versão anterior decodificava idToken sem verify → atacante anônimo
    // forjava JWT com claims arbitrários. Stress test confirmou exploit.
    // Fix definitivo: jose.jwtVerify contra o JWKS público do issuer
    // (agora em @/lib/auth/ghl-idtoken).
    let isAdmin = false;
    let adminSource = "";
    let jwtVerifyError: { code?: string; message?: string } | null = null;
    let jwtClaimsMismatch: { jwtUser?: string; jwtCompany?: string } | null = null;

    // 1. Tenta verificar idToken Firebase (assinatura RS256).
    // Em prática, GHL nem sempre publica as keys públicas no JWKS standard
    // — quando funciona é o caminho mais seguro; quando falha caímos no
    // fallback de allowlist + GHL API.
    const idToken: string | undefined = body.idToken ? String(body.idToken) : undefined;
    if (idToken) {
      const result = await verifyFirebaseIdToken(idToken);
      if (result.claims) {
        const claims = result.claims;
        const matchesUser = claims.user_id === userId;
        const matchesCompany = claims.company_id === companyId;
        if (matchesUser && matchesCompany) {
          if (isAdminClaims(claims)) {
            isAdmin = true;
            adminSource = `firebase_jwt_verified (role=${claims.role || "?"}, type=${claims.type || "?"})`;
          }
        } else {
          jwtClaimsMismatch = { jwtUser: claims.user_id, jwtCompany: claims.company_id };
        }
      } else {
        jwtVerifyError = { code: result.errorCode, message: result.errorMessage };
      }
    }

    // 2. Fallback: allowlist explícita por env. Pra agency-level admins
    // que GHL API não retorna em /users/?locationId= e cujo JWT não é
    // publicly verifiable.
    //
    // Format: ASSISTANT_ALLOWED_AGENCY_USERS="userId1:companyId1,userId2:companyId2"
    // Pra ser aceito, userId+companyId têm que bater EXATAMENTE com um par.
    //
    // Segurança: companyId só é obtido via session ativa do GHL/sparkleads
    // — atacante anônimo não tem como adivinhar. Mas se quiser endurecer,
    // implementar JWKS verify quando GHL publicar keys.
    if (!isAdmin) {
      const allowlist = (process.env.ASSISTANT_ALLOWED_AGENCY_USERS || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const targetPair = `${userId}:${companyId}`;
      if (allowlist.includes(targetPair)) {
        isAdmin = true;
        adminSource = `agency_allowlist`;
      }
    }

    // 3. Fallback GHL API (location-level admins)
    if (!isAdmin) {
      const validation = await validateGHLUser(companyId, locationId, userId);
      if (validation === null) {
        // Triagem 2026-06-17: o gate isLocationSparkbotEnabled acima já passou
        // (location tem agente ativo), então a falha aqui é quase sempre a
        // location ter perdido o acesso OAuth no Spark Leads (install revogada/
        // inativa — ~metade das ~120 vivem assim) e um admin abriu o painel ali.
        // É ESPERADO e advisory (o admin vê o painel não carregar → reconecta),
        // por isso LOW (não empurra push). Era 'medium' e virou o maior sinal
        // vivo do painel à toa. Um 5xx transiente real do GHL apareceria em
        // vários outros sinais ao mesmo tempo — não some por causa disso.
        reportError({
          title: "check-admin: location sem acesso ao Spark Leads (reconectar)",
          feature: "sparkbot-check-admin",
          severity: "low",
          description: "Admin abriu o painel SparkBot numa location cuja validação no Spark Leads (GHL) falhou — provável install OAuth inativa/revogada. Reconectar a location resolve.",
          metadata: { userId, locationId },
        });
        return json({ ok: false, reason: "ghl_validation_failed" }, { status: 502 });
      }
      if (validation.isAdmin) {
        isAdmin = true;
        adminSource = "ghl_api";
      }
    }

    if (!isAdmin) {
      // Debug exposto em dev OU se body.debug=true (op auto-diagnostic).
      const wantDebug = process.env.NODE_ENV !== "production" || body.debug === true;
      if (wantDebug) {
        return json({
          ok: false,
          reason: "not_admin",
          debug: {
            jwt_verify_error: jwtVerifyError,
            jwt_claims_mismatch: jwtClaimsMismatch,
            had_id_token: !!idToken,
          },
        }, { status: 403 });
      }
      void jwtVerifyError;
      void jwtClaimsMismatch;
      return json({ ok: false, reason: "not_admin" }, { status: 403 });
    }
    console.log(`[check-admin] admin OK via ${adminSource} (user=${userId})`);

    // Encontra ou cria rep_identity. Se rep não tem phone cadastrado,
    // ainda funciona (web-only). Quando rep usar WhatsApp depois com phone
    // real, esse rep vai ser unificado por phone.
    const rep = await identifyRepByGhlUser({ ghlUserId: userId, locationId, companyId });
    if (!rep) {
      return json({ ok: false, reason: "rep_provision_failed" }, { status: 500 });
    }

    // Pedro 2026-05-04: REMOVIDO auto-accept terms + seedWebOnboardingMessage.
    // Antes: Web UI auto-aceitava termos pra evitar UX redundante (admin já
    // aceitou no Spark Leads onboarding). Mas isso quebra o flow de teste:
    // se Pedro recarrega painel ANTES da Manuela mandar 1ª msg WhatsApp,
    // termos ficam aceitos sem rep ter visto, e quando ela manda "Oi",
    // bot pula direto pra LLM normal (sem onboarding).
    //
    // Agora: Web UI passa pelo MESMO flow do WhatsApp via processIncoming —
    // primeira msg do rep recebe termos hardcoded → "aceito" → onboarding
    // (terms.ts:buildOnboardingForWhatsApp em processor.ts). Coerente.

    // Emite JWT temporário (1h) — Custom JS guarda em sessionStorage
    const token = await signSparkbotWebToken({
      rep_id: rep.id,
      ghl_user_id: userId,
      location_id: locationId,
      company_id: companyId,
      is_admin: true,
    });

    return json({
      ok: true,
      token,
      rep: {
        id: rep.id,
        name: rep.display_name || "",
        terms_accepted: !!rep.terms_accepted_at,
        active_location_id: rep.active_location_id || locationId,
      },
    });
  } catch (err) {
    console.error("[check-admin] erro:", err instanceof Error ? err.message : err);
    reportError({ title: "check-admin: erro interno (loader SparkBot não carrega)", feature: "sparkbot-check-admin", severity: "high", error: err });
    return json({ ok: false, reason: "internal_error" }, { status: 500 });
  }
}
