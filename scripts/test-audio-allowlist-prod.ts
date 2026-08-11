/**
 * O teste que faltava: a allowlist de URL rodando em MODO PRODUÇÃO.
 *
 * H73 (2026-08-11, caso Márcia). "A IA fala que não consegue ouvir áudio" durou
 * três ondas de correção porque `validateExternalUrl` libera qualquer host fora
 * de produção — então transcrever um áudio real na máquina do dev SEMPRE
 * funcionava, e em prod o fetch morria antes de começar:
 *   "URL blocked: host not in allowlist: assets.cdn.filesafe.space"
 * (assets.cdn.filesafe.space é o CDN de mídia do Spark Leads: é dali que vem
 * toda voz-nota de WhatsApp.)
 *
 * Este script força NODE_ENV=production ANTES de importar o módulo e, se
 * receber uma URL de áudio real, transcreve de ponta a ponta sob as mesmas
 * regras de produção.
 *
 * Rodar: npx tsx scripts/test-audio-allowlist-prod.ts [url-de-audio-real]
 */
process.env.NODE_ENV = "production";

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

let pass = 0;
let fail = 0;
function ok(nome: string, cond: boolean, extra = "") {
  if (cond) {
    pass++;
    console.log(`  ✅ ${nome}`);
  } else {
    fail++;
    console.log(`  ❌ ${nome} ${extra}`);
  }
}

async function main() {
  const { validateExternalUrl } = await import("@/lib/utils/url-allowlist");
  console.log(`NODE_ENV = ${process.env.NODE_ENV} (tem que ser production, senão o teste não vale)\n`);

  console.log("1) O host que quebrou a conta da Márcia");
  ok(
    "assets.cdn.filesafe.space liberado",
    validateExternalUrl("https://assets.cdn.filesafe.space/jA6uzx6tONyTeocxw4Cj/media/a.ogg").ok,
  );
  ok("filesafe.space raiz liberado", validateExternalUrl("https://filesafe.space/x/a.ogg").ok);
  ok("outro subdomínio de filesafe liberado", validateExternalUrl("https://cdn2.filesafe.space/a.ogg").ok);

  console.log("\n2) Os hosts que já funcionavam continuam funcionando");
  for (const u of [
    "https://storage.googleapis.com/bucket/a.ogg",
    "https://media.twiliocdn.com/a.mp3",
    "https://x.msgsndr.com/a.ogg",
    "https://y.leadconnectorhq.com/a.ogg",
  ]) {
    ok(`${new URL(u).hostname}`, validateExternalUrl(u).ok);
  }

  console.log("\n3) A defesa contra SSRF continua de pé");
  for (const [u, motivo] of [
    ["https://169.254.169.254/latest/meta-data/", "metadata da nuvem"],
    ["https://10.0.0.5/interno", "rede privada"],
    ["https://localhost/x", "loopback"],
    ["https://filesafe.space.evil.com/a.ogg", "domínio que só PARECE filesafe"],
    ["https://evil.com/a.ogg", "host desconhecido"],
    ["http://assets.cdn.filesafe.space/a.ogg", "http puro em produção"],
  ] as const) {
    ok(`bloqueia ${motivo}`, !validateExternalUrl(u).ok, `→ ${JSON.stringify(validateExternalUrl(u))}`);
  }

  const urlReal = process.argv[2];
  if (urlReal) {
    console.log("\n4) Transcrição ponta a ponta sob as regras de produção");
    const { transcribeAudioFromUrlVerbose } = await import("@/lib/ai/audio-transcriber");
    const r = await transcribeAudioFromUrlVerbose(urlReal);
    if (r.ok) {
      ok(`transcreveu: "${r.result.text.slice(0, 60)}…"`, r.result.text.length > 0);
    } else {
      ok(`transcreveu (falhou: ${r.code} ${r.message.slice(0, 120)})`, false);
    }
  } else {
    console.log("\n4) (sem URL de áudio no argumento — pulando a transcrição real)");
  }

  console.log(`\n${pass}/${pass + fail} passaram`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
