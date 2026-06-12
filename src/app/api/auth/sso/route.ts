import { NextRequest, NextResponse } from "next/server";
import { validateGHLUser, upsertLocation, createSession } from "@/lib/auth/sso";
import { GHLClient } from "@/lib/ghl/client";
import { createAdminClient } from "@/lib/supabase/admin";
import { ssoSchema, validateBody } from "@/lib/utils/validation";
import { reportError } from "@/lib/admin-signals/report-error";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { data, error } = validateBody(ssoSchema, body);

    if (error || !data) {
      return NextResponse.json({ error: error || "Dados invalidos" }, { status: 400 });
    }

    // F42 (Pedro 2026-06-02): GHL Custom Menu Link só interpola {{user.id}} +
    // {{location.id}}. Quando company_id vier vazio, descobre via tabela
    // locations (populada pelo OAuth install). Fail-closed se nem isso achar.
    let companyId = data.company_id || "";
    if (!companyId) {
      const supabase = createAdminClient();
      const { data: loc } = await supabase
        .from("locations")
        .select("company_id")
        .eq("location_id", data.location_id)
        .maybeSingle();
      if (loc?.company_id) {
        companyId = loc.company_id;
        console.log("[SSO] company_id descoberto via locations table:", { locationId: data.location_id, companyId });
      } else {
        console.warn("[SSO] company_id ausente e location não encontrada:", { locationId: data.location_id });
        return NextResponse.json(
          { error: "company_id ausente e location_id não tem registro prévio. Re-instale o app via OAuth pra criar o vínculo." },
          { status: 400 },
        );
      }
    }

    // Acesso de agency admin/user (Pedro 2026-06-11): o Custom Menu Link manda
    // user_id+location_id CRUS e validateGHLUser confirma o user na LISTA da
    // location — mas agency admin/user NÃO aparecem nessa lista (a GHL API não
    // retorna users de agência por location; é o MESMO motivo do caminho idToken
    // no ui-auth, ver comentário lá). Sem isto, agency batia no fail-closed e via
    // "Falha na validação do usuário". Reusa a allowlist EXPLÍCITA já provada no
    // ui-auth/check-admin (`userId:companyId`, vírgula-separada). NÃO é wildcard —
    // mantém o fail-closed contra forja de user_id no POST público; o admin lista
    // exatamente quem libera. Match = agency admin (isAdmin=true). Cross-company é
    // barrado: a chave amarra companyId, e GHLClient não consegue cunhar token de
    // location de outra company (getLocationToken falha), então dados não vazam.
    const agencyAllowlist = (process.env.ASSISTANT_ALLOWED_AGENCY_USERS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    let isAdmin: boolean;
    if (agencyAllowlist.includes(`${data.user_id}:${companyId}`)) {
      isAdmin = true;
      console.log("[SSO] agency user liberado via allowlist:", { userId: data.user_id, companyId });
    } else {
      const validationResult = await validateGHLUser(
        companyId,
        data.location_id,
        data.user_id
      );

      if (!validationResult) {
        return NextResponse.json({ error: "Falha na validacao do usuario" }, { status: 403 });
      }
      isAdmin = validationResult.isAdmin;
    }

    // Buscar timezone da location via GHL API
    let locationTimezone = "America/New_York";
    // locationName real vem do fetch da location abaixo; "Minha Location" só
    // sobrevive se esse fetch falhar (agency user tem token de location válido,
    // então no caminho normal é sempre sobrescrito pelo nome real).
    let locationName = "Minha Location";
    try {
      const client = new GHLClient(companyId, data.location_id);
      const locationData = await client.get<{
        location?: { timezone?: string; name?: string; };
        timezone?: string;
        name?: string;
      }>(`/locations/${data.location_id}`);

      const tz = locationData.location?.timezone || locationData.timezone;
      // Validar timezone contra lista conhecida
      if (tz && isValidTimezone(tz)) locationTimezone = tz;
      const name = locationData.location?.name || locationData.name;
      if (name) locationName = name;
    } catch {
      console.log("[SSO] Could not fetch location timezone, using default");
    }

    console.log("[SSO] User authenticated:", {
      id: data.user_id,
      locationName,
      timezone: locationTimezone,
    });

    await upsertLocation(data.location_id, companyId, locationName, locationTimezone);

    await createSession({
      userId: data.user_id,
      companyId,
      locationId: data.location_id,
      locationName,
      isAdmin,
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Erro no SSO:", error);
    reportError({ title: "SSO: falha no login", feature: "auth-sso", severity: "high", error });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Erro interno" },
      { status: 500 }
    );
  }
}

function isValidTimezone(tz: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
