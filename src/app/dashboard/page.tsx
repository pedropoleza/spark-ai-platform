"use client";

import { useEffect, useState, useCallback } from "react";
import { toast } from "sonner";
import { PageWrapper } from "@/components/layout/page-wrapper";
import { AgentCard } from "@/components/dashboard/agent-card";
import { Skeleton } from "@/components/ui/skeleton";
import type { Agent } from "@/types/agent";

interface AgentActivity {
  agentId: string;
  lastActivity?: string;
  messagesProcessed24h: number;
}

export default function DashboardPage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [sparkbot, setSparkbot] = useState<Agent | null>(null);
  const [loading, setLoading] = useState(true);
  const [activityMap, setActivityMap] = useState<Record<string, AgentActivity>>({});

  const fetchAgents = useCallback(async () => {
    try {
      // Sparkbot é global — fetch em paralelo
      fetch("/api/agents/sparkbot")
        .then(async (r) => {
          if (!r.ok) {
            console.warn("[Dashboard] /api/agents/sparkbot failed:", r.status, await r.text().catch(() => ""));
            return null;
          }
          return r.json();
        })
        .then((data) => {
          console.log("[Dashboard] sparkbot fetch result:", data);
          setSparkbot(data?.agent || null);
        })
        .catch((err) => {
          console.error("[Dashboard] sparkbot fetch error:", err);
        });

      const response = await fetch("/api/agents");
      if (response.ok) {
        const data = await response.json();
        const agentsList: Agent[] = data.agents || [];
        setAgents(agentsList);
        setLoading(false);

        // Fetch activity stats em paralelo (nao bloqueia render)
        const activityPromises = agentsList.map(async (agent) => {
          try {
            const actRes = await fetch(`/api/agents/${agent.id}/activity`);
            if (actRes.ok) {
              const actData = await actRes.json();
              return {
                id: agent.id,
                lastActivity: actData.last_activity || undefined,
                messagesProcessed24h: actData.messages_24h || 0,
              };
            }
          } catch { /* non-critical */ }
          return null;
        });

        const results = await Promise.all(activityPromises);
        const newMap: Record<string, AgentActivity> = {};
        for (const r of results) {
          if (r) newMap[r.id] = { agentId: r.id, lastActivity: r.lastActivity, messagesProcessed24h: r.messagesProcessed24h };
        }
        setActivityMap(newMap);
      }
    } catch (error) {
      console.error("Erro ao buscar agentes:", error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAgents();
  }, [fetchAgents]);

  const [, setTogglingType] = useState<string | null>(null);

  const agentLabel = (type: string) =>
    type === "sales_agent" ? "Agente de Vendas" : type === "recruitment_agent" ? "Agente de Recrutamento" : "Assistente";

  const handleToggle = async (agentType: string, active: boolean) => {
    setTogglingType(agentType);
    try {
      const existingAgent = agents.find((a) => a.type === agentType);

      let res: Response;
      if (existingAgent) {
        res = await fetch(`/api/agents/${existingAgent.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: active ? "active" : "inactive" }),
        });
      } else {
        res = await fetch("/api/agents", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: agentType }),
        });
      }

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error(`Erro ao ${active ? "ativar" : "desativar"} ${agentLabel(agentType)}`, {
          description: data.error || "Tente novamente.",
        });
        return;
      }

      await fetchAgents();

      if (active) {
        toast.success(`${agentLabel(agentType)} ativado`, {
          description: "O agente está recebendo e processando mensagens.",
        });

        // Activation Safety Gate: check config for missing rules/calendar
        const activatedAgent = agents.find((a) => a.type === agentType) || (await res.json().catch(() => null));
        const agentIdForCheck = existingAgent?.id || activatedAgent?.id;
        if (agentIdForCheck) {
          try {
            const configRes = await fetch(`/api/agents/${agentIdForCheck}/config`);
            if (configRes.ok) {
              const configData = await configRes.json();
              const agentConfig = configData.config;
              if (agentConfig) {
                if (!agentConfig.targeting_rules || agentConfig.targeting_rules.length === 0) {
                  toast.warning("Agente ativado SEM regras de segmentação — vai responder a TODOS os contatos. Configure as regras em Segmentação.", { duration: 8000 });
                }
                if (
                  agentConfig.objective &&
                  agentConfig.objective.includes("booking") &&
                  !agentConfig.calendar_id
                ) {
                  toast.warning("Agente ativado SEM calendário configurado — agendamentos não vão funcionar.", { duration: 8000 });
                }
              }
            }
          } catch {
            // Non-critical safety check
          }
        }
      } else {
        toast.info(`${agentLabel(agentType)} desativado`, {
          description: "O agente não irá processar novas mensagens.",
        });
      }
    } catch (error) {
      console.error("Erro ao atualizar agente:", error);
      toast.error("Erro de conexão", { description: "Não foi possível atualizar o agente." });
    } finally {
      setTogglingType(null);
    }
  };

  const salesAgent = agents.find((a) => a.type === "sales_agent");
  const recruitmentAgent = agents.find((a) => a.type === "recruitment_agent");

  return (
    <PageWrapper
      title="Hub de Agentes"
      subtitle="Configure e gerencie seus agentes de IA"
    >
      {/* Etapa 5 prep (Pedro 2026-05-28): banner soft pra avisar do novo hub.
          Não bloqueia — só sinaliza. Cutover hard (rewrite /dashboard → /hub)
          fica como follow-up até smoke supervisionado das flags ativadas. */}
      <div
        style={{
          marginBottom: 16,
          padding: "10px 14px",
          background: "var(--primary-soft, #DBEAFE)",
          border: "1px solid var(--primary, #1675F2)",
          borderRadius: 6,
          display: "flex",
          gap: 10,
          alignItems: "center",
          flexWrap: "wrap",
        }}
      >
        <span style={{ fontSize: 13, color: "var(--primary-ink, #1E3A8A)" }}>
          ✨ <strong>Novo hub disponível!</strong> A nova experiência tem campanhas (sequência, recorrência, A/B), opt-outs automáticos, filtros avançados de agente e billing por período.
        </span>
        <a
          href="/hub"
          style={{
            marginLeft: "auto",
            padding: "4px 12px",
            background: "var(--primary, #1675F2)",
            color: "#fff",
            borderRadius: 4,
            fontSize: 12.5,
            fontWeight: 500,
            textDecoration: "none",
            whiteSpace: "nowrap",
          }}
        >
          Abrir novo hub →
        </a>
      </div>
      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          <Skeleton className="h-48" />
          <Skeleton className="h-48" />
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          <AgentCard
            type="sales_agent"
            status={salesAgent?.status}
            agentId={salesAgent?.id}
            lastActivity={salesAgent?.id ? activityMap[salesAgent.id]?.lastActivity : undefined}
            messagesProcessed24h={salesAgent?.id ? activityMap[salesAgent.id]?.messagesProcessed24h : undefined}
            onToggle={(active) => handleToggle("sales_agent", active)}
          />
          <AgentCard
            type="recruitment_agent"
            status={recruitmentAgent?.status}
            agentId={recruitmentAgent?.id}
            lastActivity={recruitmentAgent?.id ? activityMap[recruitmentAgent.id]?.lastActivity : undefined}
            messagesProcessed24h={recruitmentAgent?.id ? activityMap[recruitmentAgent.id]?.messagesProcessed24h : undefined}
            onToggle={(active) => handleToggle("recruitment_agent", active)}
          />
          <AgentCard
            type="account_assistant"
            status={sparkbot?.status}
            agentId={sparkbot?.id}
            comingSoon={!sparkbot}
          />
        </div>
      )}
    </PageWrapper>
  );
}
