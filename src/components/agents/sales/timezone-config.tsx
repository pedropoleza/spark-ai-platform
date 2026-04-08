"use client";

import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { TimezoneConfig } from "@/types/agent";

const TIMEZONES = [
  { value: "America/New_York", label: "Eastern (ET)" },
  { value: "America/Chicago", label: "Central (CT)" },
  { value: "America/Denver", label: "Mountain (MT)" },
  { value: "America/Los_Angeles", label: "Pacific (PT)" },
  { value: "America/Phoenix", label: "Arizona (MST)" },
  { value: "America/Anchorage", label: "Alaska (AKT)" },
  { value: "Pacific/Honolulu", label: "Hawaii (HST)" },
  { value: "America/Sao_Paulo", label: "Brasilia (BRT)" },
  { value: "UTC", label: "UTC" },
];

interface TimezoneConfigEditorProps {
  config: TimezoneConfig;
  locationTimezone: string;
  onChange: (config: TimezoneConfig) => void;
}

export function TimezoneConfigEditor({ config, locationTimezone, onChange }: TimezoneConfigEditorProps) {
  const update = <K extends keyof TimezoneConfig>(key: K, value: TimezoneConfig[K]) => {
    onChange({ ...config, [key]: value });
  };

  return (
    <div className="space-y-4">
      {/* Timezone padrao */}
      <div className="flex items-center gap-3">
        <Switch
          checked={config.use_location_default}
          onCheckedChange={(v) => update("use_location_default", v)}
          id="tz-default"
        />
        <div>
          <Label htmlFor="tz-default">Usar timezone da conta</Label>
          <p className="text-xs text-neutral-400">
            Timezone atual da conta: {locationTimezone}
          </p>
        </div>
      </div>

      {!config.use_location_default && (
        <div>
          <Label className="text-xs">Timezone personalizado</Label>
          <Select
            value={config.custom_timezone || locationTimezone}
            onValueChange={(v) => update("custom_timezone", v)}
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
      )}

      {/* Auto-detect */}
      <div className="flex items-center gap-3">
        <Switch
          checked={config.auto_detect_from_state}
          onCheckedChange={(v) => update("auto_detect_from_state", v)}
          id="tz-autodetect"
        />
        <div>
          <Label htmlFor="tz-autodetect">Detectar timezone pelo estado</Label>
          <p className="text-xs text-neutral-400">
            Se o lead informar o estado (ex: Florida), o sistema detecta o timezone automaticamente
          </p>
        </div>
      </div>

      {/* Confirmar antes de agendar */}
      <div className="flex items-center gap-3">
        <Switch
          checked={config.confirm_before_booking}
          onCheckedChange={(v) => update("confirm_before_booking", v)}
          id="tz-confirm"
        />
        <div>
          <Label htmlFor="tz-confirm">Confirmar timezone antes de agendar</Label>
          <p className="text-xs text-neutral-400">
            A IA pergunta ao lead se o timezone esta correto antes de marcar o agendamento
          </p>
        </div>
      </div>
    </div>
  );
}
