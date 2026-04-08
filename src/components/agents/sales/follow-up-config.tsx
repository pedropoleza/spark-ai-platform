"use client";

import { useState } from "react";
import { Plus, Trash2, Clock, Brain } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils/cn";
import type { FollowUpConfig, FollowUpStep } from "@/types/agent";

interface FollowUpConfigEditorProps {
  config: FollowUpConfig;
  onChange: (config: FollowUpConfig) => void;
}

const INTENSITY_LABELS: Record<number, string> = {
  1: "Minimo — 1 follow-up leve",
  2: "Muito baixo",
  3: "Baixo — poucos follow-ups",
  4: "Moderado baixo",
  5: "Equilibrado",
  6: "Moderado alto",
  7: "Alto — follow-ups frequentes",
  8: "Muito alto",
  9: "Agressivo",
  10: "Maximo — follow-ups constantes",
};

function formatDelay(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / 1440)}d`;
}

export function FollowUpConfigEditor({ config, onChange }: FollowUpConfigEditorProps) {
  const [newStepDelay, setNewStepDelay] = useState("30");
  const [newStepUnit, setNewStepUnit] = useState<"minutes" | "hours" | "days">("minutes");

  const update = <K extends keyof FollowUpConfig>(key: K, value: FollowUpConfig[K]) => {
    onChange({ ...config, [key]: value });
  };

  const addManualStep = () => {
    const delayNum = Number(newStepDelay) || 30;
    let delayMinutes = delayNum;
    if (newStepUnit === "hours") delayMinutes = delayNum * 60;
    if (newStepUnit === "days") delayMinutes = delayNum * 1440;

    const newStep: FollowUpStep = { delay_minutes: delayMinutes };
    update("manual_steps", [...config.manual_steps, newStep]);
    setNewStepDelay("30");
  };

  const removeManualStep = (index: number) => {
    update("manual_steps", config.manual_steps.filter((_, i) => i !== index));
  };

  const updateStepMessage = (index: number, message: string) => {
    update(
      "manual_steps",
      config.manual_steps.map((s, i) =>
        i === index ? { ...s, custom_message: message || undefined } : s
      )
    );
  };

  return (
    <div className="space-y-6">
      {/* Toggle principal */}
      <div className="flex items-center gap-3">
        <Switch
          checked={config.enabled}
          onCheckedChange={(v) => update("enabled", v)}
          id="followup-enabled"
        />
        <div>
          <Label htmlFor="followup-enabled" className="font-medium">
            Follow-up automatico
          </Label>
          <p className="text-xs text-neutral-400">
            A IA reentra em contato com o lead caso ele pare de responder
          </p>
        </div>
      </div>

      {config.enabled && (
        <>
          {/* Modo */}
          <div>
            <Label className="mb-3 block">Modo de follow-up</Label>
            <div className="grid grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => update("mode", "ai_auto")}
                className={cn(
                  "flex flex-col items-start gap-2 p-4 border-2 rounded-xl text-left transition-all",
                  config.mode === "ai_auto"
                    ? "border-neutral-900 bg-neutral-50"
                    : "border-neutral-200 hover:border-neutral-300"
                )}
              >
                <Brain className={cn("w-5 h-5", config.mode === "ai_auto" ? "text-neutral-900" : "text-neutral-400")} />
                <span className="text-sm font-medium">IA automatica</span>
                <span className="text-xs text-neutral-500">
                  A IA decide quando e o que enviar com base na intensidade
                </span>
              </button>
              <button
                type="button"
                onClick={() => update("mode", "manual")}
                className={cn(
                  "flex flex-col items-start gap-2 p-4 border-2 rounded-xl text-left transition-all",
                  config.mode === "manual"
                    ? "border-neutral-900 bg-neutral-50"
                    : "border-neutral-200 hover:border-neutral-300"
                )}
              >
                <Clock className={cn("w-5 h-5", config.mode === "manual" ? "text-neutral-900" : "text-neutral-400")} />
                <span className="text-sm font-medium">Manual</span>
                <span className="text-xs text-neutral-500">
                  Voce define os horarios e mensagens de cada follow-up
                </span>
              </button>
            </div>
          </div>

          {/* Modo IA automatica */}
          {config.mode === "ai_auto" && (
            <div className="space-y-4">
              <div>
                <div className="flex items-center justify-between mb-3">
                  <Label>Intensidade</Label>
                  <Badge variant="secondary">{config.intensity}/10</Badge>
                </div>
                <Slider
                  value={[config.intensity]}
                  onValueChange={([v]) => update("intensity", v)}
                  min={1}
                  max={10}
                  step={1}
                />
                <p className="text-xs text-neutral-400 mt-2">
                  {INTENSITY_LABELS[config.intensity] || ""}
                </p>
              </div>

              {/* Limites de tempo */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label>Primeiro follow-up apos</Label>
                  <div className="flex items-center gap-2 mt-1.5">
                    <Input
                      type="number"
                      min={1}
                      value={config.min_delay_minutes || 10}
                      onChange={(e) => update("min_delay_minutes", Number(e.target.value) || 10)}
                      className="w-20"
                    />
                    <span className="text-sm text-neutral-500">minutos</span>
                  </div>
                  <p className="text-xs text-neutral-400 mt-1">
                    Tempo minimo ate o 1o follow-up
                  </p>
                </div>
                <div>
                  <Label>Ultimo follow-up ate</Label>
                  <div className="flex items-center gap-2 mt-1.5">
                    <Input
                      type="number"
                      min={1}
                      value={Math.round((config.max_delay_minutes || 10080) / 1440)}
                      onChange={(e) => update("max_delay_minutes", (Number(e.target.value) || 7) * 1440)}
                      className="w-20"
                    />
                    <span className="text-sm text-neutral-500">dias</span>
                  </div>
                  <p className="text-xs text-neutral-400 mt-1">
                    Tempo maximo para o ultimo follow-up
                  </p>
                </div>
              </div>

              <div>
                <Label>Maximo de tentativas</Label>
                <Input
                  type="number"
                  min={1}
                  max={20}
                  value={config.max_attempts}
                  onChange={(e) => update("max_attempts", Number(e.target.value) || 5)}
                  className="mt-1.5 w-32"
                />
                <p className="text-xs text-neutral-400 mt-1">
                  Numero maximo de follow-ups antes de parar
                </p>
              </div>
            </div>
          )}

          {/* Modo manual */}
          {config.mode === "manual" && (
            <div className="space-y-4">
              <div>
                <Label className="mb-2 block">Etapas de follow-up</Label>
                <div className="space-y-3">
                  {config.manual_steps.map((step, index) => (
                    <div
                      key={index}
                      className="p-3 bg-white border border-neutral-200 rounded-lg space-y-2"
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <Badge variant="secondary" className="text-xs">
                            #{index + 1}
                          </Badge>
                          <span className="text-sm text-neutral-700">
                            Apos {formatDelay(step.delay_minutes)}
                          </span>
                        </div>
                        <button
                          type="button"
                          onClick={() => removeManualStep(index)}
                          className="text-neutral-300 hover:text-red-500"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                      <Input
                        value={step.custom_message || ""}
                        onChange={(e) => updateStepMessage(index, e.target.value)}
                        placeholder="Mensagem customizada (vazio = IA decide)"
                        className="text-sm"
                      />
                    </div>
                  ))}

                  {config.manual_steps.length === 0 && (
                    <p className="text-sm text-neutral-400">Nenhuma etapa configurada</p>
                  )}
                </div>
              </div>

              {/* Adicionar etapa */}
              <div className="flex items-end gap-2">
                <div className="flex-1">
                  <Label className="text-xs">Tempo ate o proximo follow-up</Label>
                  <div className="flex gap-2 mt-1">
                    <Input
                      type="number"
                      min={1}
                      value={newStepDelay}
                      onChange={(e) => setNewStepDelay(e.target.value)}
                      className="w-20"
                    />
                    <Select value={newStepUnit} onValueChange={(v) => setNewStepUnit(v as typeof newStepUnit)}>
                      <SelectTrigger className="w-32">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="minutes">Minutos</SelectItem>
                        <SelectItem value="hours">Horas</SelectItem>
                        <SelectItem value="days">Dias</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <Button variant="outline" size="sm" onClick={addManualStep}>
                  <Plus className="w-3.5 h-3.5 mr-1" />
                  Adicionar
                </Button>
              </div>
            </div>
          )}

          {/* Prompt de follow-up */}
          <div>
            <Label>Prompt de follow-up (opcional)</Label>
            <Textarea
              value={config.custom_prompt || ""}
              onChange={(e) => update("custom_prompt", e.target.value)}
              placeholder={`Instrucoes especificas para os follow-ups. Ex:\n- Seja mais direto nos follow-ups\n- No ultimo follow-up, ofrececa um opt-out educado\n- Mencione beneficios do seguro de vida`}
              rows={4}
              className="mt-1.5"
            />
            <p className="text-xs text-neutral-400 mt-1">
              Instrucoes adicionais para a IA usar nos follow-ups
            </p>
          </div>
        </>
      )}
    </div>
  );
}
