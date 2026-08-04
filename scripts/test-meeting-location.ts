/**
 * Testes do local da reunião (H65, caso Liberty Financial 2026-08-04) — partes
 * puras de `src/lib/queue/meeting-location.ts`.
 *
 * O caminho de CREATE não tem parte pura pra testar (o fix é justamente NÃO
 * mandar campo nenhum — provado contra o Spark Leads real em
 * scripts/probe-meeting-location-default.ts). O que se testa aqui é a
 * resolução do local EXPLÍCITO usada pra curar reunião que nasceu vazia.
 *
 * Rodar: npx tsx scripts/test-meeting-location.ts
 */
import {
  meetingLocationTypeFromKind,
  pickLocationConfig,
  explicitLocationFromConfig,
} from "../src/lib/queue/meeting-location";

let pass = 0,
  fail = 0;
function check(nome: string, cond: boolean, detalhe?: string) {
  if (cond) {
    pass++;
    console.log(`  ✅ ${nome}`);
  } else {
    fail++;
    console.error(`  ❌ ${nome}${detalhe ? ` — ${detalhe}` : ""}`);
  }
}

// Config REAL do calendário "1.1 - Primeiro Encontro" (Liberty Financial),
// round robin com 2 membros: um no Google Meet, outro no Zoom.
const CAL_LIBERTY = {
  teamMembers: [
    {
      userId: "vA6Wu9jJqRZ6VFK9BBNh",
      isPrimary: true,
      locationConfigurations: [
        { location: "", position: 0, kind: "google_conference", meetingId: "google_conference_0" },
      ],
    },
    {
      userId: "Dp23a3R4nnbBarCkVGBr",
      isPrimary: false,
      locationConfigurations: [
        { location: "", position: 0, kind: "zoom_conference", meetingId: "zoom_conference_0" },
      ],
    },
  ],
};

// Config REAL do "Consulta Inicial" da Jussara: link fixo de Zoom em `custom`.
const CAL_JUSSARA = {
  teamMembers: [
    {
      userId: "OLxJycjnHrKjv4O7S85x",
      isPrimary: true,
      locationConfigurations: [
        {
          location: "https://us06web.zoom.us/j/3212768361",
          position: 0,
          kind: "custom",
          meetingId: "custom_0",
        },
      ],
    },
  ],
};

console.log("\n1. kind do calendário → meetingLocationType da API");
check("google_conference → gmeet", meetingLocationTypeFromKind("google_conference") === "gmeet");
check("zoom_conference → zoom", meetingLocationTypeFromKind("zoom_conference") === "zoom");
check("ms_teams_conference → ms_teams", meetingLocationTypeFromKind("ms_teams_conference") === "ms_teams");
check("custom → custom", meetingLocationTypeFromKind("custom") === "custom");
check("physical → address", meetingLocationTypeFromKind("physical") === "address");
check("phone → phone", meetingLocationTypeFromKind("phone") === "phone");
check("kind desconhecido → null (não chuta)", meetingLocationTypeFromKind("teleporte") === null);
check("kind vazio → null", meetingLocationTypeFromKind(undefined) === null);

console.log("\n2. pickLocationConfig — segue o DONO da reunião");
check(
  "round robin: dono é o do Zoom → pega a config do Zoom, não a do primário",
  pickLocationConfig(CAL_LIBERTY, "Dp23a3R4nnbBarCkVGBr")?.kind === "zoom_conference",
);
check(
  "round robin: dono é o do Meet → config do Meet",
  pickLocationConfig(CAL_LIBERTY, "vA6Wu9jJqRZ6VFK9BBNh")?.kind === "google_conference",
);
check(
  "sem dono conhecido → cai no primário",
  pickLocationConfig(CAL_LIBERTY, undefined)?.kind === "google_conference",
);
check(
  "dono que não está no time → cai no primário (não devolve null)",
  pickLocationConfig(CAL_LIBERTY, "userQueNaoExiste0000")?.kind === "google_conference",
);
check("calendário sem membros → null", pickLocationConfig({ teamMembers: [] }) === null);
check("calendário indefinido → null", pickLocationConfig(undefined) === null);
check(
  "dono sem config própria → NÃO rouba a sala de outro membro (null)",
  // A sala de conferência é pessoal: usar o Zoom do colega colocaria o lead
  // numa sala que o dono da reunião não abre.
  pickLocationConfig(
    {
      teamMembers: [
        { userId: "a", isPrimary: true },
        {
          userId: "b",
          locationConfigurations: [{ kind: "zoom_conference", meetingId: "zoom_conference_0" }],
        },
      ],
    },
    "a",
  ) === null,
);
check(
  "config só no nível do calendário → usa ela",
  pickLocationConfig({
    teamMembers: [],
    locationConfigurations: [{ kind: "custom", meetingId: "custom_0", location: "https://x" }],
  })?.kind === "custom",
);

console.log("\n3. explicitLocationFromConfig — payload do PUT");
check(
  "google_conference → gmeet + meetingId + override",
  JSON.stringify(explicitLocationFromConfig(pickLocationConfig(CAL_LIBERTY, "vA6Wu9jJqRZ6VFK9BBNh"))) ===
    JSON.stringify({
      meetingLocationType: "gmeet",
      meetingLocationId: "google_conference_0",
      overrideLocationConfig: true,
    }),
);
check(
  "zoom_conference → zoom (sem address: o link é gerado pelo Spark Leads)",
  JSON.stringify(explicitLocationFromConfig(pickLocationConfig(CAL_LIBERTY, "Dp23a3R4nnbBarCkVGBr"))) ===
    JSON.stringify({
      meetingLocationType: "zoom",
      meetingLocationId: "zoom_conference_0",
      overrideLocationConfig: true,
    }),
);
check(
  "custom com link fixo → repassa o address (senão volta vazio) — caso Jussara",
  JSON.stringify(explicitLocationFromConfig(pickLocationConfig(CAL_JUSSARA))) ===
    JSON.stringify({
      meetingLocationType: "custom",
      meetingLocationId: "custom_0",
      overrideLocationConfig: true,
      address: "https://us06web.zoom.us/j/3212768361",
    }),
);
check(
  "custom SEM link salvo → sem address (não inventa)",
  explicitLocationFromConfig({ kind: "custom", meetingId: "custom_0", location: "" })?.address ===
    undefined,
);
check("config null → null", explicitLocationFromConfig(null) === null);
check(
  "kind desconhecido → null (o caller não mexe no local)",
  explicitLocationFromConfig({ kind: "holograma", meetingId: "x_0" }) === null,
);
check(
  "sem meetingId → null (o Spark Leads exige o id da config)",
  explicitLocationFromConfig({ kind: "google_conference" }) === null,
);

console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass}/${pass + fail} passaram`);
process.exit(fail === 0 ? 0 : 1);
