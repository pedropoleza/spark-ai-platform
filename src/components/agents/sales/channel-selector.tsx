"use client";

import { MessageSquare, Camera, Mail, Phone } from "lucide-react";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils/cn";
import type { CommunicationChannel } from "@/types/agent";

const CHANNELS: {
  value: CommunicationChannel;
  label: string;
  icon: typeof Phone;
  description: string;
}[] = [
  { value: "SMS", label: "SMS / WhatsApp Web", icon: Phone, description: "SMS e WhatsApp via numero do Spark" },
  { value: "WhatsApp", label: "WhatsApp API", icon: MessageSquare, description: "WhatsApp Business API (numero dedicado)" },
  { value: "Instagram", label: "Instagram", icon: Camera, description: "Direct Messages" },
  { value: "Email", label: "Email", icon: Mail, description: "Email" },
];

interface ChannelSelectorProps {
  selected: CommunicationChannel[];
  onChange: (channels: CommunicationChannel[]) => void;
}

export function ChannelSelector({ selected, onChange }: ChannelSelectorProps) {
  const toggle = (channel: CommunicationChannel) => {
    if (selected.includes(channel)) {
      // Nao permitir desativar todos
      if (selected.length <= 1) return;
      onChange(selected.filter((c) => c !== channel));
    } else {
      onChange([...selected, channel]);
    }
  };

  return (
    <div className="space-y-3">
      <div>
        <Label>Canais de comunicacao</Label>
        <p className="text-xs text-gray-500 mt-0.5">
          O agente responde pelo mesmo canal que o lead usou para enviar a mensagem
        </p>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {CHANNELS.map((ch) => {
          const Icon = ch.icon;
          const isSelected = selected.includes(ch.value);

          return (
            <button
              key={ch.value}
              type="button"
              onClick={() => toggle(ch.value)}
              className={cn(
                "flex flex-col items-center gap-2 p-4 border-2 rounded-xl transition-all",
                isSelected
                  ? "border-brand-500 bg-brand-50 shadow-[0_0_0_1px_rgba(139,92,246,0.2),0_8px_24px_-8px_rgba(139,92,246,0.3)]"
                  : "border-gray-200 hover:border-gray-200 opacity-50"
              )}
            >
              <Icon className={cn("w-5 h-5", isSelected ? "text-gray-900" : "text-gray-500")} />
              <span className={cn("text-sm font-medium", isSelected ? "text-gray-900" : "text-gray-400")}>
                {ch.label}
              </span>
              <span className="text-[10px] text-gray-500">{ch.description}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
