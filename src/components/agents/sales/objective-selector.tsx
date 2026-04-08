"use client";

import { cn } from "@/lib/utils/cn";
import { Target, CalendarCheck, Calendar } from "lucide-react";
import type { AgentObjective } from "@/types/agent";

const objectives: {
  value: AgentObjective;
  label: string;
  description: string;
  icon: typeof Target;
}[] = [
  {
    value: "qualification_only",
    label: "Apenas Qualificacao",
    description: "O agente coleta informacoes do lead sem agendar reuniao",
    icon: Target,
  },
  {
    value: "qualification_and_booking",
    label: "Qualificacao + Agendamento",
    description: "O agente qualifica o lead e agenda uma reuniao",
    icon: CalendarCheck,
  },
  {
    value: "booking_only",
    label: "Apenas Agendamento",
    description: "O agente agenda reuniao direto, sem qualificacao",
    icon: Calendar,
  },
];

interface ObjectiveSelectorProps {
  value: AgentObjective;
  onChange: (value: AgentObjective) => void;
}

export function ObjectiveSelector({ value, onChange }: ObjectiveSelectorProps) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
      {objectives.map((obj) => {
        const Icon = obj.icon;
        const isSelected = value === obj.value;

        return (
          <button
            key={obj.value}
            type="button"
            onClick={() => onChange(obj.value)}
            className={cn(
              "relative flex flex-col items-start p-4 rounded-xl border-2 text-left transition-all",
              isSelected
                ? "border-neutral-900 bg-neutral-50"
                : "border-neutral-200 hover:border-neutral-300"
            )}
          >
            <Icon
              className={cn(
                "w-5 h-5 mb-3",
                isSelected ? "text-neutral-900" : "text-neutral-400"
              )}
            />
            <span
              className={cn(
                "text-sm font-medium mb-1",
                isSelected ? "text-neutral-900" : "text-neutral-700"
              )}
            >
              {obj.label}
            </span>
            <span className="text-xs text-neutral-500">{obj.description}</span>
          </button>
        );
      })}
    </div>
  );
}
