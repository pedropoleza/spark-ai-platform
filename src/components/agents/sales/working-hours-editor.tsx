"use client";

import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { WorkingHoursConfig, WorkingHoursDay } from "@/types/agent";

const DAYS = [
  { key: "monday", label: "Segunda" },
  { key: "tuesday", label: "Terca" },
  { key: "wednesday", label: "Quarta" },
  { key: "thursday", label: "Quinta" },
  { key: "friday", label: "Sexta" },
  { key: "saturday", label: "Sabado" },
  { key: "sunday", label: "Domingo" },
];

const TIMEZONES = [
  { value: "America/New_York", label: "Eastern (ET)" },
  { value: "America/Chicago", label: "Central (CT)" },
  { value: "America/Denver", label: "Mountain (MT)" },
  { value: "America/Los_Angeles", label: "Pacific (PT)" },
  { value: "America/Sao_Paulo", label: "Brasilia (BRT)" },
  { value: "UTC", label: "UTC" },
];

interface WorkingHoursEditorProps {
  config: WorkingHoursConfig;
  onChange: (config: WorkingHoursConfig) => void;
}

export function WorkingHoursEditor({ config, onChange }: WorkingHoursEditorProps) {
  const update = <K extends keyof WorkingHoursConfig>(key: K, value: WorkingHoursConfig[K]) => {
    onChange({ ...config, [key]: value });
  };

  const updateDay = (dayKey: string, updates: Partial<WorkingHoursDay>) => {
    onChange({
      ...config,
      schedule: {
        ...config.schedule,
        [dayKey]: { ...config.schedule[dayKey], ...updates },
      },
    });
  };

  return (
    <div className="space-y-5">
      {/* Toggle principal */}
      <div className="flex items-center gap-3">
        <Switch
          checked={config.enabled}
          onCheckedChange={(v) => update("enabled", v)}
          id="wh-enabled"
        />
        <div>
          <Label htmlFor="wh-enabled" className="font-medium">
            Horario de funcionamento
          </Label>
          <p className="text-xs text-neutral-400">
            Controle em quais horarios o agente esta ativo
          </p>
        </div>
      </div>

      {config.enabled && (
        <>
          {/* Modo + Timezone */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label className="text-xs">Modo</Label>
              <Select
                value={config.mode}
                onValueChange={(v) => update("mode", v as WorkingHoursConfig["mode"])}
              >
                <SelectTrigger className="mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="only_during">Ativar APENAS durante estes horarios</SelectItem>
                  <SelectItem value="only_outside">Ativar APENAS fora destes horarios</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-neutral-400 mt-1">
                {config.mode === "only_during"
                  ? "O agente so responde nos horarios configurados"
                  : "O agente so responde fora dos horarios configurados (ex: apenas fora do expediente)"}
              </p>
            </div>
            <div>
              <Label className="text-xs">Fuso horario</Label>
              <Select
                value={config.timezone}
                onValueChange={(v) => update("timezone", v)}
              >
                <SelectTrigger className="mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TIMEZONES.map((tz) => (
                    <SelectItem key={tz.value} value={tz.value}>
                      {tz.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Tabela de dias */}
          <div>
            <Label className="text-xs mb-2 block">Agenda semanal</Label>
            <div className="space-y-2">
              {DAYS.map(({ key, label }) => {
                const day = config.schedule[key] || { enabled: false, start: "09:00", end: "17:00" };
                return (
                  <div
                    key={key}
                    className="flex items-center gap-3 p-2.5 bg-white border border-neutral-200 rounded-lg"
                  >
                    <Switch
                      checked={day.enabled}
                      onCheckedChange={(v) => updateDay(key, { enabled: v })}
                      className="scale-75"
                    />
                    <span className="text-sm font-medium text-neutral-700 w-20">
                      {label}
                    </span>
                    {day.enabled ? (
                      <div className="flex items-center gap-2">
                        <Input
                          type="time"
                          value={day.start}
                          onChange={(e) => updateDay(key, { start: e.target.value })}
                          className="w-28 h-8 text-sm"
                        />
                        <span className="text-xs text-neutral-400">ate</span>
                        <Input
                          type="time"
                          value={day.end}
                          onChange={(e) => updateDay(key, { end: e.target.value })}
                          className="w-28 h-8 text-sm"
                        />
                      </div>
                    ) : (
                      <span className="text-xs text-neutral-400">Desativado</span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
