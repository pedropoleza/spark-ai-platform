"use client";

import { Plus, Trash2, Tag, Database, GitBranch } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import type { TargetingRule, TargetingRuleType } from "@/types/agent";

interface GHLPipeline {
  id: string;
  name: string;
  stages: { id: string; name: string; position: number }[];
}

interface GHLTag {
  id: string;
  name: string;
}

interface GHLCustomField {
  id: string;
  name: string;
  fieldKey: string;
  dataType: string;
  isStandard?: boolean;
}

interface TargetingRulesEditorProps {
  rules: TargetingRule[];
  pipelines: GHLPipeline[];
  tags: GHLTag[];
  customFields: GHLCustomField[];
  loading: boolean;
  onChange: (rules: TargetingRule[]) => void;
}

const RULE_TYPES: { value: TargetingRuleType; label: string; icon: typeof Tag; description: string }[] = [
  { value: "tag", label: "Por Tag", icon: Tag, description: "Ativar quando o contato tiver uma tag especifica" },
  { value: "custom_field", label: "Por Custom Field", icon: Database, description: "Ativar quando um campo tiver um valor especifico" },
  { value: "pipeline_stage", label: "Por Estagio no Pipeline", icon: GitBranch, description: "Ativar quando o lead entrar em um estagio" },
];

export function TargetingRulesEditor({
  rules,
  pipelines,
  tags,
  customFields,
  loading,
  onChange,
}: TargetingRulesEditorProps) {

  const addRule = (type: TargetingRuleType) => {
    const newRule: TargetingRule = {
      id: crypto.randomUUID(),
      type,
    };
    onChange([...rules, newRule]);
  };

  const removeRule = (id: string) => {
    onChange(rules.filter((r) => r.id !== id));
  };

  const updateRule = (id: string, updates: Partial<TargetingRule>) => {
    onChange(rules.map((r) => (r.id === id ? { ...r, ...updates } : r)));
  };

  const selectedPipelineForRule = (rule: TargetingRule) => {
    return pipelines.find((p) => p.id === rule.pipeline_id);
  };

  return (
    <div className="space-y-4">
      {rules.length > 0 && (
        <p className="text-xs text-neutral-400">
          O agente ativa quando <strong>qualquer uma</strong> das regras abaixo for atendida.
        </p>
      )}

      {/* Lista de regras */}
      <div className="space-y-3">
        {rules.map((rule, index) => {
          const ruleType = RULE_TYPES.find((t) => t.value === rule.type);
          const Icon = ruleType?.icon || Tag;

          return (
            <div
              key={rule.id}
              className="p-4 bg-white/5 border border-white/10 rounded-lg space-y-3"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Badge variant="secondary" className="text-xs gap-1">
                    <Icon className="w-3 h-3" />
                    {ruleType?.label}
                  </Badge>
                  <span className="text-xs text-neutral-400">Regra {index + 1}</span>
                </div>
                <button
                  type="button"
                  onClick={() => removeRule(rule.id)}
                  className="text-neutral-300 hover:text-red-500 transition-colors"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>

              {/* Tag rule */}
              {rule.type === "tag" && (
                <div>
                  <Label className="text-xs">Tag</Label>
                  {loading ? (
                    <Skeleton className="h-10 mt-1" />
                  ) : (
                    <Select
                      value={rule.tag || ""}
                      onValueChange={(v) => updateRule(rule.id, { tag: v })}
                    >
                      <SelectTrigger className="mt-1">
                        <SelectValue placeholder="Selecione uma tag..." />
                      </SelectTrigger>
                      <SelectContent>
                        {tags.map((t) => (
                          <SelectItem key={t.id || t.name} value={t.name}>
                            {t.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </div>
              )}

              {/* Custom field rule */}
              {rule.type === "custom_field" && (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label className="text-xs">Campo</Label>
                    {loading ? (
                      <Skeleton className="h-10 mt-1" />
                    ) : (
                      <Select
                        value={rule.custom_field_key || ""}
                        onValueChange={(v) => updateRule(rule.id, { custom_field_key: v })}
                      >
                        <SelectTrigger className="mt-1">
                          <SelectValue placeholder="Selecione..." />
                        </SelectTrigger>
                        <SelectContent>
                          {customFields.map((f) => (
                            <SelectItem key={f.id} value={f.fieldKey}>
                              {f.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  </div>
                  <div>
                    <Label className="text-xs">Valor esperado</Label>
                    <Input
                      value={rule.custom_field_value || ""}
                      onChange={(e) => updateRule(rule.id, { custom_field_value: e.target.value })}
                      placeholder="Ex: true"
                      className="mt-1"
                    />
                  </div>
                </div>
              )}

              {/* Pipeline stage rule */}
              {rule.type === "pipeline_stage" && (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label className="text-xs">Pipeline</Label>
                    {loading ? (
                      <Skeleton className="h-10 mt-1" />
                    ) : (
                      <Select
                        value={rule.pipeline_id || ""}
                        onValueChange={(v) =>
                          updateRule(rule.id, { pipeline_id: v, pipeline_stage_id: undefined })
                        }
                      >
                        <SelectTrigger className="mt-1">
                          <SelectValue placeholder="Selecione..." />
                        </SelectTrigger>
                        <SelectContent>
                          {pipelines.map((p) => (
                            <SelectItem key={p.id} value={p.id}>
                              {p.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  </div>
                  <div>
                    <Label className="text-xs">Estagio</Label>
                    <Select
                      value={rule.pipeline_stage_id || ""}
                      onValueChange={(v) => updateRule(rule.id, { pipeline_stage_id: v })}
                      disabled={!rule.pipeline_id}
                    >
                      <SelectTrigger className="mt-1">
                        <SelectValue placeholder="Selecione..." />
                      </SelectTrigger>
                      <SelectContent>
                        {(selectedPipelineForRule(rule)?.stages || [])
                          .sort((a, b) => a.position - b.position)
                          .map((s) => (
                            <SelectItem key={s.id} value={s.id}>
                              {s.name}
                            </SelectItem>
                          ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Adicionar regra */}
      {rules.length === 0 ? (
        <div className="space-y-3">
          <p className="text-sm text-neutral-500">
            Adicione pelo menos uma regra para definir quais leads o agente deve abordar.
          </p>
          <div className="grid grid-cols-3 gap-3">
            {RULE_TYPES.map((rt) => {
              const Icon = rt.icon;
              return (
                <button
                  key={rt.value}
                  type="button"
                  onClick={() => addRule(rt.value)}
                  className="flex flex-col items-center gap-2 p-4 border-2 border-dashed border-white/10 rounded-xl hover:border-white/30 transition-colors"
                >
                  <Icon className="w-5 h-5 text-neutral-400" />
                  <span className="text-sm font-medium text-neutral-200">{rt.label}</span>
                  <span className="text-[10px] text-neutral-400 text-center">{rt.description}</span>
                </button>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <span className="text-xs text-neutral-400">Adicionar outra regra:</span>
          {RULE_TYPES.map((rt) => (
            <Button
              key={rt.value}
              variant="outline"
              size="sm"
              onClick={() => addRule(rt.value)}
              className="text-xs h-7"
            >
              <Plus className="w-3 h-3 mr-1" />
              {rt.label}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}
