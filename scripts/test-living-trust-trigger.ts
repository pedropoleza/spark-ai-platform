import { pickTriggeredDataFieldRules } from "../src/lib/ai/reaction-engine";
import type { AutomationRule } from "../src/types/agent";
const CAMPO="servico_nao_atendido";
const regra = { id:"auto-living-trust", trigger:{kind:"on_data_field_set",field_key:CAMPO,operator:"contains",value:"living_trust"}, actions:[{type:"add_tag",tag:"x"},{type:"pause_ai",pause_minutes:0}] } as AutomationRule;
let ok=0, fail=0;
const t=(nome:string, prev:Record<string,string>, next:Record<string,string>, ja:string[], esperado:boolean)=>{
  const r=pickTriggeredDataFieldRules([regra],prev,next,new Set(ja));
  const got=r.length>0;
  if(got===esperado){ok++;console.log(`  ✅ ${nome}`);}else{fail++;console.log(`  ❌ ${nome} — esperado ${esperado}, veio ${got}`);}
};
console.log("GATILHO on_data_field_set / contains 'living_trust':");
t("campo nasce com living_trust", {}, {[CAMPO]:"living_trust"}, [], true);
t("campo vazio → nao dispara", {}, {}, [], false);
t("outro valor no campo", {}, {[CAMPO]:"consorcio"}, [], false);
t("ja disparou antes (dedup)", {}, {[CAMPO]:"living_trust"}, ["auto-living-trust"], false);
t("nao muda entre turnos", {[CAMPO]:"living_trust"}, {[CAMPO]:"living_trust"}, [], false);
t("outro campo muda", {}, {nome_completo_1:"Giovani"}, [], false);
t("valor com espaco em volta", {}, {[CAMPO]:" living_trust "}, [], true);
t("frase contendo o valor", {}, {[CAMPO]:"quer living_trust urgente"}, [], true);
console.log(`\n${ok} ok, ${fail} falhas`);
process.exit(fail?1:0);
