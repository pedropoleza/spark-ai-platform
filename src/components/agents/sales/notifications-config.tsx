"use client";

import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { NotificationsConfig } from "@/types/agent";

interface NotificationsConfigEditorProps {
  config: NotificationsConfig;
  onChange: (config: NotificationsConfig) => void;
}

export function NotificationsConfigEditor({ config, onChange }: NotificationsConfigEditorProps) {
  const update = <K extends keyof NotificationsConfig>(key: K, value: NotificationsConfig[K]) => {
    onChange({ ...config, [key]: value });
  };

  const events = [
    { key: "on_qualified" as const, label: "Lead qualificado", description: "Quando o agente coleta todos os dados do lead" },
    { key: "on_booked" as const, label: "Agendamento realizado", description: "Quando uma reuniao e agendada com sucesso" },
    { key: "on_handed_off" as const, label: "Transferido para humano", description: "Quando o lead pede para falar com uma pessoa" },
    { key: "on_error" as const, label: "Erro no processamento", description: "Quando o agente encontra um erro" },
  ];

  return (
    <div className="space-y-5">
      <div>
        <Label>Email para notificacoes</Label>
        <Input
          type="email"
          value={config.notification_email}
          onChange={(e) => update("notification_email", e.target.value)}
          placeholder="seu@email.com"
          className="mt-1.5 max-w-sm"
        />
        <p className="text-xs text-neutral-400 mt-1">
          Deixe vazio para desativar todas as notificacoes
        </p>
      </div>

      <div className="space-y-3">
        <Label>Eventos</Label>
        {events.map((event) => (
          <div key={event.key} className="flex items-center gap-3 p-3 bg-white border border-neutral-200 rounded-lg">
            <Switch
              checked={config[event.key]}
              onCheckedChange={(v) => update(event.key, v)}
              disabled={!config.notification_email}
            />
            <div>
              <span className="text-sm font-medium text-neutral-900">{event.label}</span>
              <p className="text-xs text-neutral-400">{event.description}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
