"use client";

import { useRouter } from "next/navigation";
import { Headphones, UserCog, Users, Settings2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils/cn";
import type { AgentType, AgentStatus } from "@/types/agent";

const iconMap = {
  sales_agent: Headphones,
  recruitment_agent: Users,
  account_assistant: UserCog,
};

const typeLabels: Record<AgentType, { name: string; description: string }> = {
  sales_agent: {
    name: "Agente de Vendas",
    description: "Qualifica leads e agenda reuniões com corretores",
  },
  recruitment_agent: {
    name: "Agente de Recrutamento",
    description: "Qualifica candidatos e agenda entrevistas com especialistas",
  },
  account_assistant: {
    name: "Assistente de Conta",
    description: "Auxilia clientes com dúvidas sobre suas contas",
  },
};

interface AgentCardProps {
  type: AgentType;
  status?: AgentStatus;
  agentId?: string;
  comingSoon?: boolean;
  lastActivity?: string;
  messagesProcessed24h?: number;
  onToggle?: (active: boolean) => void;
}

function formatTimeAgo(isoDate: string): string {
  const diff = Date.now() - new Date(isoDate).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "agora";
  if (minutes < 60) return `há ${minutes}min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `há ${hours}h`;
  const days = Math.floor(hours / 24);
  return `há ${days}d`;
}

export function AgentCard({
  type,
  status = "inactive",
  agentId,
  comingSoon = false,
  lastActivity,
  messagesProcessed24h,
  onToggle,
}: AgentCardProps) {
  const router = useRouter();
  const Icon = iconMap[type];
  const info = typeLabels[type];
  const isActive = status === "active";

  return (
    <Card className={cn("group relative overflow-hidden surface-card-hover", comingSoon && "opacity-60")}>
      {isActive && !comingSoon && (
        <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-brand-500/60 to-transparent" />
      )}
      <CardContent className="p-6">
        <div className="flex items-start justify-between mb-5">
          <div className="relative">
            <div className={cn(
              "w-11 h-11 rounded-xl flex items-center justify-center border transition-all duration-300",
              isActive && !comingSoon
                ? "brand-gradient border-brand-400/40 shadow-[0_8px_20px_-8px_rgba(22,117,242,0.45)]"
                : "bg-gray-50 border-gray-200"
            )}>
              <Icon className={cn("w-5 h-5", isActive && !comingSoon ? "text-white" : "text-gray-500")} />
            </div>
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

        <h3 className="font-semibold text-gray-900 mb-1 tracking-tight">{info.name}</h3>
        <p className="text-sm text-gray-500 mb-2 leading-relaxed">{info.description}</p>

        {!comingSoon && (
          <p className="text-xs text-gray-400 mb-4">
            {lastActivity
              ? `Última atividade: ${formatTimeAgo(lastActivity)}${messagesProcessed24h ? ` · ${messagesProcessed24h} mensagens hoje` : ""}`
              : "Sem atividade"}
          </p>
        )}

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
