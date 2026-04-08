"use client";

import { useRouter } from "next/navigation";
import { Headphones, UserCog, Users, Settings2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { AgentType, AgentStatus } from "@/types/agent";

const iconMap = {
  sales_agent: Headphones,
  recruitment_agent: Users,
  account_assistant: UserCog,
};

const typeLabels: Record<AgentType, { name: string; description: string }> = {
  sales_agent: {
    name: "Agente de Vendas",
    description: "Qualifica leads e agenda reunioes com corretores",
  },
  recruitment_agent: {
    name: "Agente de Recrutamento",
    description: "Qualifica candidatos e agenda entrevistas com especialistas",
  },
  account_assistant: {
    name: "Assistente de Conta",
    description: "Auxilia clientes com duvidas sobre suas contas",
  },
};

interface AgentCardProps {
  type: AgentType;
  status?: AgentStatus;
  agentId?: string;
  comingSoon?: boolean;
  onToggle?: (active: boolean) => void;
}

export function AgentCard({
  type,
  status = "inactive",
  agentId,
  comingSoon = false,
  onToggle,
}: AgentCardProps) {
  const router = useRouter();
  const Icon = iconMap[type];
  const info = typeLabels[type];
  const isActive = status === "active";

  return (
    <Card className={comingSoon ? "opacity-60" : ""}>
      <CardContent className="p-6">
        <div className="flex items-start justify-between mb-4">
          <div className="w-10 h-10 rounded-lg bg-neutral-100 flex items-center justify-center">
            <Icon className="w-5 h-5 text-neutral-600" />
          </div>
          {comingSoon ? (
            <Badge variant="secondary">Em breve</Badge>
          ) : (
            <div className="flex items-center gap-2">
              <Badge variant={isActive ? "success" : "secondary"}>
                {isActive ? "Ativo" : "Inativo"}
              </Badge>
              <Switch
                checked={isActive}
                onCheckedChange={onToggle}
                aria-label={`${isActive ? "Desativar" : "Ativar"} ${info.name}`}
              />
            </div>
          )}
        </div>

        <h3 className="font-semibold text-neutral-900 mb-1">{info.name}</h3>
        <p className="text-sm text-neutral-500 mb-4">{info.description}</p>

        {!comingSoon && (
          <Button
            variant="outline"
            size="sm"
            className="w-full"
            onClick={() => {
              const route = type === "recruitment_agent" ? "/agents/recruitment" : "/agents/sales";
              router.push(`${route}${agentId ? `?id=${agentId}` : ""}`);
            }}
          >
            <Settings2 className="w-3.5 h-3.5 mr-2" />
            Configurar
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
