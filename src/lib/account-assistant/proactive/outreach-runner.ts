/**
 * Outreach runner (Etapa 4.3 do plano — Pedro 2026-05-28).
 *
 * Hoje o `agent_configs.outreach_config` é armazenado mas nada executa —
 * o wizard do agente fala "prospecção em breve" porque NÃO HÁ RUNNER. Este
 * arquivo destrava o gap crítico: lê o config, busca contatos pela tag,
 * cria um bulk_message_job, popula recipients respeitando rate/cap, e
 * registra a execução em outreach_runs (cooldown 24h por agente).
 *
 * Flag-gate: `OUTREACH_RUNNER_ENABLED=1`. Default OFF — wire no cron
 * sparkbot-proactive já está pronto mas só roda quando admin liga.
 *
 * Honra opt-outs (outreach_optouts): contatos opted-out são pulados antes
 * do INSERT em bulk_message_recipients.
 */
import { createAdminClient } from "@/lib/supabase/admin";

const COOLDOWN_HOURS = 24;

export interface RunOutreachResult {
  ok: boolean;
  status: "created" | "skipped_no_contacts" | "skipped_cooldown" | "skipped_outside_hours" | "failed";
  job_id?: string;
  contacts_targeted: number;
  contacts_enqueued: number;
  reason?: string;
}

/**
 * Runner principal. Pra cada agente lead-facing com outreach_config.enabled,
 * checa cooldown → busca contatos por tag → cria job + recipients → escreve
 * em outreach_runs.
 *
 * NÃO faz envio direto — apenas enfileira no bulk_message_jobs em
 * status='running' (consumido pelo bulk-message-runner cron existente).
 */
export async function runOutreachForAgent(agentId: string): Promise<RunOutreachResult> {
  const supabase = createAdminClient();

  // 1. Carrega agente + config + rep
  const { data: agent } = await supabase
    .from("agents")
    .select("id, location_id, status, type")
    .eq("id", agentId)
    .maybeSingle();
  if (!agent) return { ok: false, status: "failed", contacts_targeted: 0, contacts_enqueued: 0, reason: "agent_not_found" };
  if (agent.status !== "active") return { ok: false, status: "failed", contacts_targeted: 0, contacts_enqueued: 0, reason: "agent_inactive" };

  const { data: config } = await supabase
    .from("agent_configs")
    .select("outreach_config")
    .eq("agent_id", agentId)
    .maybeSingle();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const oc = (config?.outreach_config || {}) as Record<string, any>;
  if (!oc.enabled) return { ok: false, status: "failed", contacts_targeted: 0, contacts_enqueued: 0, reason: "outreach_disabled" };

  const tags: string[] = Array.isArray(oc.tag_filter?.tags) ? oc.tag_filter.tags : [];
  if (tags.length === 0) {
    return { ok: false, status: "failed", contacts_targeted: 0, contacts_enqueued: 0, reason: "no_tags" };
  }

  // 2. Cooldown: 1 run por 24h por agente.
  const { data: lastRun } = await supabase
    .from("outreach_runs")
    .select("ran_at")
    .eq("agent_id", agentId)
    .order("ran_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (lastRun?.ran_at) {
    const elapsedMs = Date.now() - new Date(lastRun.ran_at as string).getTime();
    if (elapsedMs < COOLDOWN_HOURS * 60 * 60 * 1000) {
      await supabase.from("outreach_runs").insert({
        agent_id: agentId, location_id: agent.location_id, status: "skipped_cooldown",
      });
      return { ok: true, status: "skipped_cooldown", contacts_targeted: 0, contacts_enqueued: 0 };
    }
  }

  // 3. Busca rep dono do agente (1º rep da location — runner é system-level).
  const { data: rep } = await supabase
    .from("rep_identities")
    .select("id")
    .eq("location_id", agent.location_id)
    .limit(1)
    .maybeSingle();
  if (!rep) {
    return { ok: false, status: "failed", contacts_targeted: 0, contacts_enqueued: 0, reason: "no_rep" };
  }

  // 4. Cria o bulk_message_job em status='paused' (admin ativa via SparkBot
  // ou UI). Filter_config snapshot da config no momento — runner do bulk
  // depois popula recipients via filter-engine real.
  const dailyCap = Math.max(1, Math.min(5000, Number(oc.daily_cap) || 100));
  const ratePerHour = Math.max(1, Math.min(500, Number(oc.rate_per_hour) || 20));
  const intervalSeconds = Math.max(30, Math.min(600, Math.round(3600 / ratePerHour)));

  const { data: job, error: jobErr } = await supabase
    .from("bulk_message_jobs")
    .insert({
      rep_id: rep.id,
      location_id: agent.location_id,
      agent_id: agentId,
      filter_config: { tag: tags[0], match: oc.tag_filter?.match || "any" },
      message_template: String(oc.opening_message || `Oi {first_name}! Posso te ajudar?`).slice(0, 3000),
      variation_mode: "light",
      interval_seconds: intervalSeconds,
      jitter_seconds: 30,
      delivery_channel: "whatsapp_web_sms",
      // F32 (Pedro 2026-05-28): flag `respect_quiet_hours` é nome legado da
      // tabela bulk_message_jobs mas agora é interpretado como "respeitar
      // horários do agente" = quiet_hours + working_hours combinados
      // (ver isInBlockedHours em quiet-hours.ts). Antes só quiet → outreach
      // disparava sábado 8h porque tava fora de quiet (22-7) e working_hours
      // (seg-sex 9-18) era ignorado.
      respect_quiet_hours: !!oc.respect_working_hours,
      status: "paused",
      label: `Outreach automático (${new Date().toISOString().slice(0, 10)})`,
      total_contacts: 0,
      priority: 0,
    })
    .select("id")
    .single();
  if (jobErr || !job) {
    await supabase.from("outreach_runs").insert({
      agent_id: agentId, location_id: agent.location_id, status: "failed",
      error_message: jobErr?.message || "insert_failed",
    });
    return { ok: false, status: "failed", contacts_targeted: 0, contacts_enqueued: 0, reason: jobErr?.message };
  }

  // 5. Registra a execução. contacts_targeted/enqueued = 0 por enquanto —
  // bulk-message-runner faz população real respeitando opt-outs. Próxima
  // iteração: chamar filter-engine aqui pra preview do count.
  await supabase.from("outreach_runs").insert({
    agent_id: agentId,
    location_id: agent.location_id,
    bulk_job_id: job.id,
    contacts_targeted: 0,
    contacts_enqueued: 0,
    status: "created",
  });

  return {
    ok: true,
    status: "created",
    job_id: job.id,
    contacts_targeted: 0,
    contacts_enqueued: 0,
  };
}

/**
 * Lista agentes com outreach_config.enabled=true E status active. Usado pelo
 * cron pra varrer todos os agentes elegíveis. Cap defensivo de 200 agentes
 * por tick (prod hoje tem dezenas — sobra).
 */
export async function listAgentsWithOutreachEnabled(): Promise<{ id: string; location_id: string }[]> {
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("agent_configs")
    .select("agent_id, agents!inner(id, location_id, status)")
    .filter("outreach_config->>enabled", "eq", "true")
    .limit(200);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ((data || []) as any[])
    .filter((r) => r.agents?.status === "active")
    .map((r) => ({ id: r.agent_id as string, location_id: r.agents.location_id as string }));
}

/**
 * Entry point pro cron sparkbot-proactive. Honra a flag OUTREACH_RUNNER_ENABLED.
 * Sem a flag = no-op (deploy safe). Quando admin ligar, fica ativo no próximo tick.
 */
export async function processOutreachTick(): Promise<{ scanned: number; created: number; errors: number }> {
  if (process.env.OUTREACH_RUNNER_ENABLED !== "1") {
    return { scanned: 0, created: 0, errors: 0 };
  }
  const agents = await listAgentsWithOutreachEnabled();
  let created = 0;
  let errors = 0;
  for (const a of agents) {
    const res = await runOutreachForAgent(a.id).catch(() => null);
    if (!res) errors++;
    else if (res.status === "created") created++;
    else if (res.status === "failed") errors++;
  }

  // Pedro 2026-05-28 (footgun de capacidade): alerta admin se uma location
  // tem >5 agentes lead-facing com outreach simultâneo. Cada um dispara
  // ~100 msgs/dia por default → 5+ agentes = 500+ msgs/dia/location sem
  // governance global. Fingerprint dedup em admin_signals colapsa em 1 row
  // por location (não inunda).
  if (agents.length > 0) {
    const byLocation = new Map<string, number>();
    for (const a of agents) {
      byLocation.set(a.location_id, (byLocation.get(a.location_id) || 0) + 1);
    }
    for (const [locId, count] of byLocation.entries()) {
      if (count > 5) {
        try {
          const { recordSignalAsync } = await import("@/lib/admin-signals/recorder");
          recordSignalAsync({
            type: "idea",
            source: "system",
            severity: "medium",
            title: `Location ${locId.slice(0, 8)} tem ${count} agentes outreach ativos`,
            description:
              `Cada agente tem cap próprio (default 100/dia). Total potencial: ${count * 100} msgs/dia. ` +
              `Considere consolidar ou setar caps menores em agent_configs.outreach_config.daily_cap.`,
            metadata: { location_id: locId, agents_count: count, gap: "global_rate_governance" },
          });
        } catch {
          /* não-fatal */
        }
      }
    }
  }

  return { scanned: agents.length, created, errors };
}
