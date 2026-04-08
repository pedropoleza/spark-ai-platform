"use client";

import { useState } from "react";
import { Plus, Trash2, Zap, Tag, GitBranch, Database } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { AutomationRule, AutomationAction } from "@/types/agent";

interface GHLPipeline {
  id: string;
  name: string;
  stages: { id: string; name: string; position: number }[];
}

interface GHLTag { id: string; name: string; }
interface GHLCustomField { id: string; name: string; fieldKey: string; isStandard?: boolean; }

const DEFAULT_EVENTS = [
  { value: "qualified", label: "Lead qualificado" },
  { value: "booked", label: "Agendamento realizado" },
  { value: "handed_off", label: "Transferido para humano" },
  { value: "disqualified", label: "Lead desqualificado" },
  { value: "stale", label: "Lead inativo" },
];

const ACTION_TYPES = [
  { value: "add_tag", label: "Adicionar tag", icon: Tag },
  { value: "remove_tag", label: "Remover tag", icon: Tag },
  { value: "move_pipeline", label: "Mover no pipeline", icon: GitBranch },
  { value: "update_field", label: "Atualizar campo", icon: Database },
];

interface AutomationsEditorProps {
  rules: AutomationRule[];
  pipelines: GHLPipeline[];
  tags: GHLTag[];
  customFields: GHLCustomField[];
  onChange: (rules: AutomationRule[]) => void;
}

export function AutomationsEditor({ rules, pipelines, tags, customFields, onChange }: AutomationsEditorProps) {
  const [showAdd, setShowAdd] = useState(false);
  const [newEvent, setNewEvent] = useState("qualified");
  const [customEventLabel, setCustomEventLabel] = useState("");

  const addRule = () => {
    const isCustom = newEvent === "custom";
    const rule: AutomationRule = {
      id: crypto.randomUUID(),
      event: isCustom ? customEventLabel.toLowerCase().replace(/\s+/g, "_") : newEvent,
      event_label: isCustom ? customEventLabel : DEFAULT_EVENTS.find((e) => e.value === newEvent)?.label,
      actions: [],
    };
    onChange([...rules, rule]);
    setShowAdd(false);
    setNewEvent("qualified");
    setCustomEventLabel("");
  };

  const removeRule = (id: string) => onChange(rules.filter((r) => r.id !== id));

  const addAction = (ruleId: string) => {
    onChange(rules.map((r) => r.id === ruleId ? {
      ...r,
      actions: [...r.actions, { type: "add_tag" as const }],
    } : r));
  };

  const updateAction = (ruleId: string, actionIdx: number, updates: Partial<AutomationAction>) => {
    onChange(rules.map((r) => r.id === ruleId ? {
      ...r,
      actions: r.actions.map((a, i) => i === actionIdx ? { ...a, ...updates } : a),
    } : r));
  };

  const removeAction = (ruleId: string, actionIdx: number) => {
    onChange(rules.map((r) => r.id === ruleId ? {
      ...r,
      actions: r.actions.filter((_, i) => i !== actionIdx),
    } : r));
  };

  const getEventLabel = (event: string) => {
    return DEFAULT_EVENTS.find((e) => e.value === event)?.label || event;
  };

  return (
    <div className="space-y-4">
      <p className="text-xs text-neutral-400">
        Configure acoes automaticas que sao executadas quando um evento acontece na conversa.
      </p>

      {/* Lista de regras */}
      {rules.map((rule) => (
        <div key={rule.id} className="border border-neutral-200 rounded-lg overflow-hidden">
          {/* Header da regra */}
          <div className="flex items-center justify-between p-3 bg-neutral-50">
            <div className="flex items-center gap-2">
              <Zap className="w-4 h-4 text-neutral-500" />
              <span className="text-sm font-medium">Quando:</span>
              <Badge variant="secondary">{rule.event_label || getEventLabel(rule.event)}</Badge>
            </div>
            <button onClick={() => removeRule(rule.id)} className="text-neutral-300 hover:text-red-500">
              <Trash2 className="w-4 h-4" />
            </button>
          </div>

          {/* Actions */}
          <div className="p-3 space-y-2">
            {rule.actions.length === 0 && (
              <p className="text-xs text-neutral-400">Nenhuma acao configurada</p>
            )}

            {rule.actions.map((action, actionIdx) => {
              const selectedPipeline = pipelines.find((p) => p.id === action.pipeline_id);

              return (
                <div key={actionIdx} className="flex items-center gap-2 p-2 bg-white border border-neutral-100 rounded-lg">
                  {/* Tipo da acao */}
                  <Select
                    value={action.type}
                    onValueChange={(v) => updateAction(rule.id, actionIdx, { type: v as AutomationAction["type"] })}
                  >
                    <SelectTrigger className="w-44 h-8 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {ACTION_TYPES.map((at) => (
                        <SelectItem key={at.value} value={at.value}>{at.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>

                  {/* Params por tipo */}
                  {(action.type === "add_tag" || action.type === "remove_tag") && (
                    <Select
                      value={action.tag || ""}
                      onValueChange={(v) => updateAction(rule.id, actionIdx, { tag: v })}
                    >
                      <SelectTrigger className="flex-1 h-8 text-xs">
                        <SelectValue placeholder="Selecione tag..." />
                      </SelectTrigger>
                      <SelectContent>
                        {tags.map((t) => (
                          <SelectItem key={t.id || t.name} value={t.name}>{t.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}

                  {action.type === "move_pipeline" && (
                    <>
                      <Select
                        value={action.pipeline_id || ""}
                        onValueChange={(v) => updateAction(rule.id, actionIdx, { pipeline_id: v, stage_id: "" })}
                      >
                        <SelectTrigger className="w-40 h-8 text-xs">
                          <SelectValue placeholder="Pipeline..." />
                        </SelectTrigger>
                        <SelectContent>
                          {pipelines.map((p) => (
                            <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {selectedPipeline && (
                        <Select
                          value={action.stage_id || ""}
                          onValueChange={(v) => updateAction(rule.id, actionIdx, { stage_id: v })}
                        >
                          <SelectTrigger className="flex-1 h-8 text-xs">
                            <SelectValue placeholder="Estagio..." />
                          </SelectTrigger>
                          <SelectContent>
                            {selectedPipeline.stages.sort((a, b) => a.position - b.position).map((s) => (
                              <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                    </>
                  )}

                  {action.type === "update_field" && (
                    <>
                      <Select
                        value={action.field_key || ""}
                        onValueChange={(v) => updateAction(rule.id, actionIdx, { field_key: v })}
                      >
                        <SelectTrigger className="w-40 h-8 text-xs">
                          <SelectValue placeholder="Campo..." />
                        </SelectTrigger>
                        <SelectContent>
                          {customFields.map((f) => (
                            <SelectItem key={f.id} value={f.fieldKey || f.id}>{f.name}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Input
                        value={action.field_value || ""}
                        onChange={(e) => updateAction(rule.id, actionIdx, { field_value: e.target.value })}
                        placeholder="Valor..."
                        className="flex-1 h-8 text-xs"
                      />
                    </>
                  )}

                  <button onClick={() => removeAction(rule.id, actionIdx)} className="text-neutral-300 hover:text-red-500">
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              );
            })}

            <Button variant="outline" size="sm" className="text-xs h-7" onClick={() => addAction(rule.id)}>
              <Plus className="w-3 h-3 mr-1" />
              Adicionar acao
            </Button>
          </div>
        </div>
      ))}

      {/* Adicionar regra */}
      {showAdd ? (
        <div className="p-4 border border-neutral-200 rounded-lg bg-neutral-50 space-y-3">
          <Label className="text-xs">Evento disparador</Label>
          <Select value={newEvent} onValueChange={setNewEvent}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DEFAULT_EVENTS.map((e) => (
                <SelectItem key={e.value} value={e.value}>{e.label}</SelectItem>
              ))}
              <SelectItem value="custom">Evento personalizado...</SelectItem>
            </SelectContent>
          </Select>
          {newEvent === "custom" && (
            <Input
              value={customEventLabel}
              onChange={(e) => setCustomEventLabel(e.target.value)}
              placeholder="Nome do evento (ex: primeiro contato)"
              className="mt-2"
            />
          )}
          <div className="flex gap-2">
            <Button size="sm" onClick={addRule} disabled={newEvent === "custom" && !customEventLabel}>
              Criar regra
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setShowAdd(false)}>Cancelar</Button>
          </div>
        </div>
      ) : (
        <Button variant="outline" size="sm" onClick={() => setShowAdd(true)} className="w-full">
          <Plus className="w-3.5 h-3.5 mr-2" />
          Adicionar automacao
        </Button>
      )}
    </div>
  );
}
