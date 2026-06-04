/**
 * Unit test do F59 (reconstructHistoryFromDb). Mocka o supabase
 * (message_queue inbound + execution_log send_message) e valida o
 * merge/ordenação cronológica/extração de texto. Roda sem DB.
 * Uso: npx tsx scripts/test-history-fallback.ts
 */
import { reconstructHistoryFromDb } from "../src/lib/queue/history-fallback";

let pass = 0;
let fail = 0;
function eq(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    pass++;
    console.log(`✅ ${name}`);
  } else {
    fail++;
    console.log(`❌ ${name}\n   esperado: ${JSON.stringify(expected)}\n   recebido: ${JSON.stringify(actual)}`);
  }
}

// Stub chainable do supabase: from(table) → builder que ignora select/eq/order
// e resolve no .limit() com a fixture daquela tabela.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeSupabase(fixtures: Record<string, { data: unknown[] }>): any {
  return {
    from(table: string) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const builder: any = {
        select: () => builder,
        eq: () => builder,
        order: () => builder,
        limit: () => Promise.resolve(fixtures[table] || { data: [] }),
      };
      return builder;
    },
  };
}

async function main() {
  // Caso 1: merge + ordenação cronológica (inbound + outbound intercalados,
  // entregues fora de ordem pelo "DB" — a função tem que ordenar por timestamp).
  const sb1 = makeSupabase({
    message_queue: {
      data: [
        { message_body: "Oi ta ai?", received_at: "2026-06-04T17:15:03Z" },
        { message_body: "Olá, vim do anúncio", received_at: "2026-06-04T04:46:34Z" },
      ],
    },
    execution_log: {
      data: [{ action_payload: { message: ["Oi! Como posso ajudar?"] }, created_at: "2026-06-04T04:47:00Z" }],
    },
  });
  const turns1 = await reconstructHistoryFromDb({ supabase: sb1, locationId: "L", contactId: "C", limit: 30 });
  eq("merge + sort cronológico", turns1, [
    { role: "user", content: "Olá, vim do anúncio" },
    { role: "assistant", content: "Oi! Como posso ajudar?" },
    { role: "user", content: "Oi ta ai?" },
  ]);

  // Caso 2: message como array multi-bubble → join com \n\n
  const sb2 = makeSupabase({
    message_queue: { data: [] },
    execution_log: { data: [{ action_payload: { message: ["Linha 1", "Linha 2"] }, created_at: "2026-06-04T05:00:00Z" }] },
  });
  const turns2 = await reconstructHistoryFromDb({ supabase: sb2, locationId: "L", contactId: "C" });
  eq("multi-bubble join", turns2, [{ role: "assistant", content: "Linha 1\n\nLinha 2" }]);

  // Caso 3: message como string simples
  const sb3 = makeSupabase({
    message_queue: { data: [] },
    execution_log: { data: [{ action_payload: { message: "texto simples" }, created_at: "2026-06-04T05:00:00Z" }] },
  });
  const turns3 = await reconstructHistoryFromDb({ supabase: sb3, locationId: "L", contactId: "C" });
  eq("message string", turns3, [{ role: "assistant", content: "texto simples" }]);

  // Caso 4: vazio dos dois lados → [] (conversa nova de verdade, sem dano)
  const sb4 = makeSupabase({ message_queue: { data: [] }, execution_log: { data: [] } });
  const turns4 = await reconstructHistoryFromDb({ supabase: sb4, locationId: "L", contactId: "C" });
  eq("ambos vazios → []", turns4, []);

  // Caso 5: ignora body em branco + payload sem .message + array vazio
  const sb5 = makeSupabase({
    message_queue: {
      data: [
        { message_body: "   ", received_at: "2026-06-04T05:00:00Z" },
        { message_body: "válido", received_at: "2026-06-04T05:01:00Z" },
      ],
    },
    execution_log: {
      data: [
        { action_payload: { foo: "bar" }, created_at: "2026-06-04T05:02:00Z" },
        { action_payload: { message: [] }, created_at: "2026-06-04T05:03:00Z" },
      ],
    },
  });
  const turns5 = await reconstructHistoryFromDb({ supabase: sb5, locationId: "L", contactId: "C" });
  eq("ignora vazios/sem-message", turns5, [{ role: "user", content: "válido" }]);

  console.log(`\n${pass}/${pass + fail} passaram`);
  process.exit(fail > 0 ? 1 : 0);
}

void main();
