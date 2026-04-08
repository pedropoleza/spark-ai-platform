"use client";

import { UserCheck, MessageCircle } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils/cn";
import type { PostBookingConfig } from "@/types/agent";

interface PostBookingConfigEditorProps {
  config: PostBookingConfig;
  onChange: (config: PostBookingConfig) => void;
}

export function PostBookingConfigEditor({ config, onChange }: PostBookingConfigEditorProps) {
  const update = <K extends keyof PostBookingConfig>(key: K, value: PostBookingConfig[K]) => {
    onChange({ ...config, [key]: value });
  };

  return (
    <div className="space-y-5">
      {/* Comportamento pos-agendamento */}
      <div>
        <Label className="mb-3 block">Apos agendar, o agente deve:</Label>
        <div className="grid grid-cols-2 gap-3">
          <BehaviorCard
            icon={UserCheck}
            label="Parar e passar para humano"
            description="Encerra a conversa e avisa que um membro da equipe dara continuidade"
            selected={config.behavior === "stop_and_handoff"}
            onClick={() => update("behavior", "stop_and_handoff")}
          />
          <BehaviorCard
            icon={MessageCircle}
            label="Continuar conversando"
            description="Mantém a conversa ativa ate o horario do agendamento, respondendo duvidas"
            selected={config.behavior === "continue_until_appointment"}
            onClick={() => update("behavior", "continue_until_appointment")}
          />
        </div>
      </div>

      {/* Mensagem de handoff */}
      {config.behavior === "stop_and_handoff" && (
        <div>
          <Label>Mensagem de encerramento</Label>
          <Input
            value={config.handoff_message}
            onChange={(e) => update("handoff_message", e.target.value)}
            placeholder="Ex: Obrigado! Um membro da equipe entrara em contato."
            className="mt-1.5"
          />
          <p className="text-xs text-neutral-400 mt-1">
            Enviada apos o agendamento ser confirmado
          </p>
        </div>
      )}

      {/* Reagendamento */}
      <div className="flex items-center gap-3">
        <Switch
          checked={config.allow_reschedule}
          onCheckedChange={(v) => update("allow_reschedule", v)}
          id="allow-reschedule"
        />
        <div>
          <Label htmlFor="allow-reschedule">Permitir reagendamento</Label>
          <p className="text-xs text-neutral-400">
            Se o lead pedir para mudar o horario, a IA atualiza o agendamento existente em vez de criar um novo
          </p>
        </div>
      </div>
    </div>
  );
}

function BehaviorCard({
  icon: Icon,
  label,
  description,
  selected,
  onClick,
}: {
  icon: typeof UserCheck;
  label: string;
  description: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex flex-col items-start gap-2 p-4 border-2 rounded-xl text-left transition-all",
        selected ? "border-neutral-900 bg-neutral-50" : "border-neutral-200 hover:border-neutral-300"
      )}
    >
      <Icon className={cn("w-5 h-5", selected ? "text-neutral-900" : "text-neutral-400")} />
      <span className={cn("text-sm font-medium", selected ? "text-neutral-900" : "text-neutral-700")}>
        {label}
      </span>
      <span className="text-xs text-neutral-500">{description}</span>
    </button>
  );
}
