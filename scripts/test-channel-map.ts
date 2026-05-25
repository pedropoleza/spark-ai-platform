// Teste do mapeamento de canal (Plataforma Modular — multicanal).
// Roda: npx tsx -r tsconfig-paths/register scripts/test-channel-map.ts
//
// Fonte única em src/lib/ghl/channel.ts (antes duplicado). Trava o roteamento
// de canal — inclui o caso IG que validamos ao vivo (Alves Cury).

import { channelToMessageType, detectChannel } from "@/lib/ghl/channel";

let pass = 0;
let fail = 0;
function eq(name: string, got: string, want: string) {
  if (got === want) {
    pass++;
    console.log(`✅ ${name}: ${got}`);
  } else {
    fail++;
    console.log(`❌ ${name}: got "${got}", want "${want}"`);
  }
}

// OUTBOUND: canal → tipo GHL (resposta espelha o canal de entrada)
console.log("— channelToMessageType (outbound) —");
eq("Instagram → IG", channelToMessageType("Instagram"), "IG");
eq("WhatsApp → WhatsApp", channelToMessageType("WhatsApp"), "WhatsApp");
eq("Email → Email", channelToMessageType("Email"), "Email");
eq("SMS → SMS", channelToMessageType("SMS"), "SMS");
eq("desconhecido → SMS (default)", channelToMessageType("Telegram"), "SMS");
eq("undefined → SMS (default)", channelToMessageType(undefined), "SMS");

// INBOUND: type/customData GHL → canal canônico
console.log("\n— detectChannel (inbound) —");
eq("type IG → Instagram", detectChannel("IG"), "Instagram");
eq("type TYPE_IG → Instagram", detectChannel("TYPE_IG"), "Instagram");
eq("type INSTAGRAM → Instagram", detectChannel("INSTAGRAM"), "Instagram");
eq("type FB → Instagram", detectChannel("FB"), "Instagram");
eq("type WHATSAPP → WhatsApp", detectChannel("WHATSAPP"), "WhatsApp");
eq("type EMAIL → Email", detectChannel("EMAIL"), "Email");
eq("type SMS → SMS", detectChannel("SMS"), "SMS");
eq("customData channel=instagram → Instagram", detectChannel("TYPE_CUSTOM", "instagram"), "Instagram");
eq("customData channel=wa → WhatsApp", detectChannel("X", "wa"), "WhatsApp");
eq("type desconhecido → SMS", detectChannel("WEIRD"), "SMS");

// ROUND-TRIP: IG inbound → resposta IG (o caso do piloto)
console.log("\n— round-trip (piloto IG) —");
eq("IG inbound → reply type IG", channelToMessageType(detectChannel("IG")), "IG");

console.log(`\nTOTAL: ${pass}/${pass + fail} passaram${fail > 0 ? ` — ${fail} FALHARAM` : " ✅"}`);
process.exit(fail > 0 ? 1 : 0);
