// Teste de PARIDADE do Motor Unificado (Plataforma Modular — Fase 1).
// Roda: npx tsx -r tsconfig-paths/register scripts/test-motor-parity.ts
//
// Garante que montar o system prompt do SparkBot pelo ASSEMBLER (motor
// unificado) é IDÊNTICO a montar pelo builder legado (`buildSparkbotSystemPrompt`).
// Enquanto o assembler delega (Fase 1) isso é trivial — mas o teste vira o
// GUARD RAIL: quando começarmos a extrair seções pra módulos, qualquer drift
// (1 char que seja) quebra aqui antes de ir pra prod.

import { buildSparkbotSystemPrompt, type BuildPromptArgs } from "@/lib/account-assistant/prompt-builder";
import { assembleSystemPrompt } from "@/lib/agent-platform/assembler";
import type { RepIdentity } from "@/types/account-assistant";

const rep = {
  id: "rep-parity-0001",
  phone: "+15555550100",
  display_name: "Rep Teste",
  ghl_users: [{ location_id: "loc1", ghl_user_id: "U000000000000000001" }],
  active_location_id: "loc1",
  profile: {
    preferences: { verbosity: "normal" },
    aliases: { M3: "Inscrito M3 (20k-50k)" },
  },
  terms_accepted_at: "2026-01-01T00:00:00Z",
  unanswered_count: 0,
  unanswered_pause_until: null,
  timezone: "America/New_York",
  timezone_confirmed_at: "2026-01-01T00:00:00Z",
  is_internal: false,
} as unknown as RepIdentity;

function baseArgs(overrides: Partial<BuildPromptArgs> = {}): BuildPromptArgs {
  return {
    rep,
    locationName: "Brazillionaires",
    locationTimezone: "America/New_York",
    locale: "pt-BR",
    confirmationMode: "high_only",
    carrierOverview: "",
    channel: "whatsapp",
    customInstructions: null,
    kbInstructions: null,
    kbItems: [],
    tones: {},
    conversationalLayer: {},
    ...overrides,
  };
}

const variants: Array<{ name: string; args: BuildPromptArgs }> = [
  { name: "default (high_only, whatsapp)", args: baseArgs() },
  { name: "confirmationMode=always", args: baseArgs({ confirmationMode: "always" }) },
  { name: "confirmationMode=medium_and_high", args: baseArgs({ confirmationMode: "medium_and_high" }) },
  { name: "channel=web_ui", args: baseArgs({ channel: "web_ui" }) },
  { name: "tones setados", args: baseArgs({ tones: { creativity: 8, formality: 3, naturalness: 7, aggressiveness: 2 } }) },
  {
    name: "custom instructions + verbosity brief",
    args: baseArgs({ customInstructions: "Fala curto, sem rodeio.", conversationalLayer: { verbosityPref: "brief" } }),
  },
  { name: "en-US locale", args: baseArgs({ locale: "en-US" }) },
];

let pass = 0;
let fail = 0;
for (const v of variants) {
  const legacy = buildSparkbotSystemPrompt(v.args);
  const viaMotor = assembleSystemPrompt({ templateKey: "sparkbot", audience: "rep", sparkbotArgs: v.args });
  if (legacy === viaMotor) {
    pass++;
    console.log(`✅ paridade: ${v.name}  (${legacy.length} chars)`);
  } else {
    fail++;
    // acha o 1º ponto de divergência pra debug
    let i = 0;
    while (i < Math.min(legacy.length, viaMotor.length) && legacy[i] === viaMotor[i]) i++;
    console.log(`❌ DRIFT: ${v.name}`);
    console.log(`   legacy.len=${legacy.length} motor.len=${viaMotor.length} diverge no char ${i}`);
    console.log(`   legacy: …${JSON.stringify(legacy.slice(Math.max(0, i - 30), i + 30))}`);
    console.log(`   motor : …${JSON.stringify(viaMotor.slice(Math.max(0, i - 30), i + 30))}`);
  }
}

console.log(`\nTOTAL: ${pass}/${variants.length} idênticos${fail > 0 ? ` — ${fail} COM DRIFT` : " ✅"}`);
process.exit(fail > 0 ? 1 : 0);
