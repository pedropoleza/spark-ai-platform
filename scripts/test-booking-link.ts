/**
 * Teste do link público de agendamento (review de uso 2026-08-25).
 * Roda: npx tsx -r tsconfig-paths/register scripts/test-booking-link.ts
 *
 * Duas partes:
 *  1. PURO — montagem de URL e escolha id×slug (sem rede).
 *  2. AO VIVO — bate no widget de produção com calendários REAIS e confere que
 *     o validador separa "abre" de "404". Sem isso o fix não vale: a coisa que
 *     ele corrige é justamente um link plausível que não abre.
 *     Pula sozinho se não houver credencial de banco (`--puro` força pular).
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });

import {
  getBookingBaseUrl,
  montarBookingLinks,
  validarBookingLink,
} from "@/lib/account-assistant/booking-link";

let pass = 0;
let fail = 0;
function check(nome: string, ok: boolean, detalhe = "") {
  console.log(`${ok ? "✅" : "❌"} ${nome}${ok || !detalhe ? "" : ` — ${detalhe}`}`);
  ok ? pass++ : fail++;
}

async function main() {
  // ───────────────────── 1. PURO ─────────────────────
  console.log("1. Montagem de URL (puro)");
  const base = getBookingBaseUrl();
  check("base sem barra no fim", !base.endsWith("/"), base);

  {
    const c = montarBookingLinks("BrzfmjZIsTMhBy5at4Ue", "consulta-inicial-drabreu");
    check("id vem primeiro (imutável)", c[0]?.tipo === "id");
    check("url do id está certa", c[0]?.url === `${base}/widget/booking/BrzfmjZIsTMhBy5at4Ue`, c[0]?.url);
    check("slug curto entra como alternativa", c[1]?.tipo === "slug" && c[1].url.endsWith("/widget/bookings/consulta-inicial-drabreu"));
  }
  {
    // Slug real da VERGUS FINANCE — 100+ chars de UUID. Ninguém manda isso pra cliente.
    const feio =
      "field-training-026ff66d-d082-482a-99f9-0d6a02bd35c7-a3b41395-9a48-4edb-89cf-d172b0aea3386susv3-11ae70eb-66a0-40fc-8679-e7efc8fb709c";
    const c = montarBookingLinks("7FJtQgMprKHepwlm64ci", feio);
    check("slug sopa-de-UUID é descartado", c.length === 1 && c[0].tipo === "id", `${c.length} candidatos`);
  }
  {
    const c = montarBookingLinks("abc123", null);
    check("sem slug → só o id", c.length === 1 && c[0].tipo === "id");
    check("sem id → nenhum candidato", montarBookingLinks("", null).length === 0);
  }
  {
    const c = montarBookingLinks("a b/c", "x y");
    check("id e slug são url-encoded", c[0].url.includes("a%20b%2Fc"), c[0].url);
  }

  // ───────────────────── 2. AO VIVO ─────────────────────
  if (process.argv.includes("--puro")) {
    console.log("\n(pulei a parte ao vivo: --puro)");
  } else {
    console.log("\n2. Widget de produção (rede)");
    try {
      const { createAdminClient } = await import("@/lib/supabase/admin");
      const { GHLClient } = await import("@/lib/ghl/client");
      const sb = createAdminClient();

      // Locations dos reps que PEDIRAM o link no período + variedade de conta.
      const LOCS = [
        "zsBPmsNu0Svyu0EuB9FS", // Paulo Abreu — pediu 2×
        "sDFb4pjquY55tVDcpYdQ", // Danielle Velho — pediu 1×
        "lUSGtKw9OWla97QEqtrh", // VERGUS FINANCE — calendários em grupo + slug feio
        "KtMB8IKwmhtnKt7aimzd", // Legacy/Milton
        "cqVNnPEeWfQlH8YZPRWk", // Raquel
      ];
      let testados = 0;
      let abriram = 0;
      for (const loc of LOCS) {
        const { data: row } = await sb
          .from("locations")
          .select("company_id")
          .eq("location_id", loc)
          .maybeSingle();
        if (!row?.company_id) continue;
        const client = new GHLClient(row.company_id as string, loc);
        const res: { calendars?: Array<{ id?: string; name?: string; isActive?: boolean; widgetSlug?: string }> } =
          await client.get("/calendars/", { locationId: loc });
        const ativos = (res.calendars || []).filter((c) => c.isActive !== false && c.id).slice(0, 3);
        for (const cal of ativos) {
          const cands = montarBookingLinks(cal.id as string, cal.widgetSlug);
          const ok = await validarBookingLink(cands[0].url);
          testados++;
          if (ok === true) abriram++;
          else console.log(`   ⚠️ ${cal.name} (${loc}) → ${ok === false ? "404" : "indeterminado"} · ${cands[0].url}`);
        }
      }
      check(
        `todos os ${testados} calendários reais testados abrem`,
        testados > 0 && abriram === testados,
        `${abriram}/${testados}`,
      );

      // O validador precisa saber dizer NÃO — senão ele não vale nada.
      const falso = await validarBookingLink(`${base}/widget/booking/AAAAAAAAAAAAAAAAAAAA`);
      check("id inexistente → validador devolve false", falso === false, String(falso));
      const falsoSlug = await validarBookingLink(`${base}/widget/bookings/slug-que-nao-existe-xyz`);
      check("slug inexistente → validador devolve false", falsoSlug === false, String(falsoSlug));
      const semRede = await validarBookingLink("https://dominio-que-nao-existe-xyzq.invalid/x", 2000);
      check("host inválido → null (indeterminado, não 'ok')", semRede === null, String(semRede));
    } catch (e) {
      console.log(`   (parte ao vivo pulada: ${e instanceof Error ? e.message.slice(0, 80) : e})`);
    }
  }

  console.log(`\n${pass}/${pass + fail} OK (${Math.round((pass / (pass + fail)) * 100)}%)`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
