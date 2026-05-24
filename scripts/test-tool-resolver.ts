// Teste do tool resolver (Plataforma Modular — Fase 1).
// Roda: npx tsx -r tsconfig-paths/register scripts/test-tool-resolver.ts

import { resolveModuleToolKeys } from "@/lib/agent-platform/tool-resolver";

let pass = 0;
let fail = 0;
function eq(name: string, got: string[], want: string[]) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) {
    pass++;
    console.log(`✅ ${name}`);
  } else {
    fail++;
    console.log(`❌ ${name}\n   got=${JSON.stringify(got)}\n   want=${JSON.stringify(want)}`);
  }
}

// união dedup ordenada
eq(
  "união de módulos (dedup + sort)",
  resolveModuleToolKeys({
    moduleInstances: [
      { moduleKey: "scheduling", enabled: true, allowedTools: ["create_appointment", "get_free_slots"] },
      { moduleKey: "channel", enabled: true, allowedTools: ["send_message_to_contact", "create_appointment"] },
    ],
  }),
  ["create_appointment", "get_free_slots", "send_message_to_contact"],
);

// módulo desligado não contribui
eq(
  "módulo enabled=false é ignorado",
  resolveModuleToolKeys({
    moduleInstances: [
      { moduleKey: "scheduling", enabled: false, allowedTools: ["create_appointment"] },
      { moduleKey: "crm_ops", enabled: true, allowedTools: ["create_note"] },
    ],
  }),
  ["create_note"],
);

// disabledTools remove mesmo que um módulo libere
eq(
  "disabledTools tira tool liberada por módulo",
  resolveModuleToolKeys({
    moduleInstances: [{ moduleKey: "crm_ops", enabled: true, allowedTools: ["create_note", "delete_note"] }],
    disabledTools: ["delete_note"],
  }),
  ["create_note"],
);

// baseTools entram; disabled também aplica a eles
eq(
  "baseTools entram (e respeitam disabled)",
  resolveModuleToolKeys({
    moduleInstances: [{ moduleKey: "behavior", enabled: true, allowedTools: [] }],
    baseTools: ["search_contacts", "get_contact"],
    disabledTools: ["get_contact"],
  }),
  ["search_contacts"],
);

// sem módulos ligados → vazio
eq("nenhum módulo → []", resolveModuleToolKeys({ moduleInstances: [] }), []);

console.log(`\nTOTAL: ${pass}/${pass + fail} passaram${fail > 0 ? ` — ${fail} FALHARAM` : " ✅"}`);
process.exit(fail > 0 ? 1 : 0);
