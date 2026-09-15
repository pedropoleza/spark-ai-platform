/**
 * Números da IA da Bianca (Five Rings) — pra conversa de resultado com ela.
 *
 * Separa ANTES x DEPOIS de 26/08 de propósito: até essa data o gate de ativação
 * era uma frase exata com vírgula final, e a IA respondia ~3% de quem chegava.
 * Misturar as duas janelas esconde que o experimento mal chegou a rodar.
 *
 * "Atendida" = pessoa que recebeu ao menos uma mensagem da IA (send_message com
 * success != false), NÃO quem apenas escreveu.
 *
 *   npx tsx scripts/metricas-bianca.ts
 */
import { config as env } from "dotenv"; import { resolve } from "path";
env({ path: resolve(process.cwd(), ".env.local") });
import { createAdminClient } from "@/lib/supabase/admin";
const LOC="cRavIlyC52vFYgJATgi7";
const A="17860a86-ace9-4299-9328-2452151348a0", B="47cdcb0d-5840-4ae4-bc8b-b60e70870b50";
const FIX="2026-08-26T04:00:00Z";
const nome=(id:string)=>id===A?"Tráfego Pago":id===B?"Novos Seguidores":id;

async function pageAll(sb:any, tabela:string, cols:string, filtros:(q:any)=>any) {
  const out:any[]=[]; let from=0;
  for(;;){ const q=filtros(sb.from(tabela).select(cols)).range(from,from+999);
    const {data,error}=await q; if(error) throw error; out.push(...(data||[]));
    if(!data||data.length<1000) break; from+=1000; }
  return out;
}

(async()=>{
  const sb=createAdminClient();
  console.log("hoje:", new Date().toISOString().slice(0,10));

  const el = await pageAll(sb,"execution_log","created_at,action_type,contact_id,agent_id,success,action_payload",
    (q:any)=>q.eq("location_id",LOC));
  const mq = await pageAll(sb,"message_queue","received_at,contact_id",(q:any)=>q.eq("location_id",LOC));
  const cs = await pageAll(sb,"conversation_state","contact_id,agent_id,status,message_count,created_at,collected_data",
    (q:any)=>q.eq("location_id",LOC));

  console.log(`\nlinhas: execution_log=${el.length} fila=${mq.length} conversas=${cs.length}`);
  console.log(`1º registro: ${el.map((e:any)=>e.created_at).sort()[0]?.slice(0,10)}`);

  const janela=(t:string)=>t<FIX?"antes":"depois";
  for (const jan of ["antes","depois","TOTAL"] as const) {
    const f=(t:string)=>jan==="TOTAL"?true:janela(t)===jan;
    const sub=el.filter((e:any)=>f(e.created_at));
    const atendidos=new Set(sub.filter((e:any)=>e.action_type==="send_message"&&e.success!==false).map((e:any)=>e.contact_id));
    const msgs=sub.filter((e:any)=>e.action_type==="send_message"&&e.success!==false);
    const bolhas=msgs.reduce((n:number,e:any)=>n+(e.action_payload?.parts||1),0);
    const ag=sub.filter((e:any)=>e.action_type==="book_appointment"&&e.success!==false);
    const agC=new Set(ag.map((e:any)=>e.contact_id));
    const leads=new Set(mq.filter((m:any)=>f(m.received_at)).map((m:any)=>m.contact_id));
    console.log(`\n────── ${jan.toUpperCase()} ──────`);
    console.log(`  pessoas que escreveram : ${leads.size}`);
    console.log(`  pessoas ATENDIDAS      : ${atendidos.size}`);
    console.log(`  mensagens enviadas     : ${msgs.length} turnos / ${bolhas} bolhas`);
    console.log(`  AGENDAMENTOS           : ${ag.length} (${agC.size} pessoas)`);
    if(atendidos.size) console.log(`  conversão (agend/atend): ${((agC.size/atendidos.size)*100).toFixed(1)}%`);
  }

  // por agente, total
  console.log("\n────── POR AGENTE (vida inteira) ──────");
  for (const id of [A,B]) {
    const sub=el.filter((e:any)=>e.agent_id===id);
    const at=new Set(sub.filter((e:any)=>e.action_type==="send_message"&&e.success!==false).map((e:any)=>e.contact_id));
    const ag=sub.filter((e:any)=>e.action_type==="book_appointment"&&e.success!==false);
    console.log(`  ${nome(id).padEnd(18)} atendidos ${String(at.size).padStart(3)} · agendamentos ${ag.length}`);
  }

  // o que a IA fez
  console.log("\n────── O QUE A IA FEZ (vida inteira) ──────");
  const cont:Record<string,number>={};
  el.forEach((e:any)=>{ if(e.success!==false) cont[e.action_type]=(cont[e.action_type]||0)+1; });
  Object.entries(cont).sort((a,b)=>b[1]-a[1]).forEach(([k,v])=>console.log(`  ${String(v).padStart(4)}  ${k}`));

  // status das conversas
  console.log("\n────── STATUS DAS CONVERSAS ──────");
  const st:Record<string,number>={}; cs.forEach((c:any)=>st[c.status]=(st[c.status]||0)+1);
  console.log("  "+JSON.stringify(st));
  // dados coletados
  const comDados=cs.filter((c:any)=>c.collected_data&&Object.keys(c.collected_data).length>0);
  console.log(`  conversas com dado de qualificação coletado: ${comDados.length}`);
  const campos:Record<string,number>={};
  comDados.forEach((c:any)=>Object.keys(c.collected_data).forEach(k=>campos[k]=(campos[k]||0)+1));
  console.log("  campos: "+JSON.stringify(campos));
})();
