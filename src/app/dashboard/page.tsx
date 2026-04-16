"use client";

import { useEffect, useState, useCallback } from "react";
import { toast } from "sonner";
import { PageWrapper } from "@/components/layout/page-wrapper";
import { AgentCard } from "@/components/dashboard/agent-card";
import { Skeleton } from "@/components/ui/skeleton";
import type { Agent } from "@/types/agent";

export default function DashboardPage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchAgents = useCallback(async () => {
    try {
      const response = await fetch("/api/agents");
      if (response.ok) {
        const data = await response.json();
        setAgents(data.agents || []);
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

  const [togglingType, setTogglingType] = useState<string | null>(null);

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
          description: "O agente esta recebendo e processando mensagens.",
        });
      } else {
        toast.info(`${agentLabel(agentType)} desativado`, {
          description: "O agente nao ira processar novas mensagens.",
        });
      }
    } catch (error) {
      console.error("Erro ao atualizar agente:", error);
      toast.error("Erro de conexao", { description: "Nao foi possivel atualizar o agente." });
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
            onToggle={(active) => handleToggle("sales_agent", active)}
          />
          <AgentCard
            type="recruitment_agent"
            status={recruitmentAgent?.status}
            agentId={recruitmentAgent?.id}
            onToggle={(active) => handleToggle("recruitment_agent", active)}
          />
          <AgentCard type="account_assistant" comingSoon />
        </div>
      )}
    </PageWrapper>
  );
}
