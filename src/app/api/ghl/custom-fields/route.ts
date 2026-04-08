import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/sso";
import { GHLClient } from "@/lib/ghl/client";

// Campos padrao do GHL que existem em todo contato
const STANDARD_FIELDS = [
  { id: "contact.firstName", name: "First Name", fieldKey: "contact.firstName", dataType: "TEXT", isStandard: true },
  { id: "contact.lastName", name: "Last Name", fieldKey: "contact.lastName", dataType: "TEXT", isStandard: true },
  { id: "contact.name", name: "Full Name", fieldKey: "contact.name", dataType: "TEXT", isStandard: true },
  { id: "contact.email", name: "Email", fieldKey: "contact.email", dataType: "TEXT", isStandard: true },
  { id: "contact.phone", name: "Phone", fieldKey: "contact.phone", dataType: "PHONE", isStandard: true },
  { id: "contact.address1", name: "Address", fieldKey: "contact.address1", dataType: "TEXT", isStandard: true },
  { id: "contact.city", name: "City", fieldKey: "contact.city", dataType: "TEXT", isStandard: true },
  { id: "contact.state", name: "State", fieldKey: "contact.state", dataType: "TEXT", isStandard: true },
  { id: "contact.postalCode", name: "Postal Code", fieldKey: "contact.postalCode", dataType: "TEXT", isStandard: true },
  { id: "contact.country", name: "Country", fieldKey: "contact.country", dataType: "TEXT", isStandard: true },
  { id: "contact.dateOfBirth", name: "Date of Birth", fieldKey: "contact.dateOfBirth", dataType: "DATE", isStandard: true },
  { id: "contact.companyName", name: "Company Name", fieldKey: "contact.companyName", dataType: "TEXT", isStandard: true },
  { id: "contact.website", name: "Website", fieldKey: "contact.website", dataType: "TEXT", isStandard: true },
  { id: "contact.source", name: "Source", fieldKey: "contact.source", dataType: "TEXT", isStandard: true },
];

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Nao autenticado" }, { status: 401 });
  }

  try {
    const client = new GHLClient(session.companyId, session.locationId);

    // Tentar diferentes endpoints da API do GHL para custom fields
    let ghlCustomFields: unknown[] = [];

    try {
      // Endpoint v2: /locations/{locationId}/customFields
      const data = await client.get<{ customFields: unknown[] }>(
        `/locations/${session.locationId}/customFields`
      );
      ghlCustomFields = data.customFields || [];
    } catch {
      try {
        // Fallback: /customFields
        const data = await client.get<{ customFields: unknown[] }>(
          "/customFields",
          { locationId: session.locationId }
        );
        ghlCustomFields = data.customFields || [];
      } catch (e) {
        console.error("Erro ao buscar custom fields do GHL:", e);
      }
    }

    // Combinar campos padrao + custom fields
    const allFields = [
      ...STANDARD_FIELDS,
      ...(ghlCustomFields as Record<string, unknown>[]).map((f) => ({
        ...f,
        isStandard: false,
      })),
    ];

    return NextResponse.json({ customFields: allFields });
  } catch (error) {
    console.error("Erro ao buscar custom fields:", error);
    // Mesmo se falhar, retornar pelo menos os campos padrao
    return NextResponse.json({ customFields: STANDARD_FIELDS });
  }
}
