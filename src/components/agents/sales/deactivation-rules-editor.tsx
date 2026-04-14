"use client";

import { Plus, Trash2, Power } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { DeactivationRule } from "@/types/agent";

interface GHLTag { id: string; name: string; }
interface GHLCustomField { id: string; name: string; fieldKey: string; }

interface DeactivationRulesEditorProps {
  rules: DeactivationRule[];
  tags: GHLTag[];
  customFields: GHLCustomField[];
  onChange: (rules: DeactivationRule[]) => void;
}

export function DeactivationRulesEditor({ rules, tags, customFields, onChange }: DeactivationRulesEditorProps) {
  const addRule = () => {
    onChange([...rules, { id: crypto.randomUUID(), type: "tag_added" }]);
  };

  const updateRule = (id: string, updates: Partial<DeactivationRule>) => {
    onChange(rules.map((r) => (r.id === id ? { ...r, ...updates } : r)));
  };

  const removeRule = (id: string) => {
    onChange(rules.filter((r) => r.id !== id));
  };

  return (
    <div className="space-y-4">
      <div>
        <Label className="flex items-center gap-2">
          <Power className="w-4 h-4" />
          Regras de desligamento
        </Label>
        <p className="text-xs text-gray-500 mt-1">
          A IA para de responder quando qualquer uma dessas condicoes for atendida.
          Tambem para se o contato perder o criterio de ativacao (targeting rules).
        </p>
      </div>

      {rules.map((rule) => (
        <div key={rule.id} className="flex items-center gap-2 p-3 bg-gray-50 border border-gray-200 rounded-lg">
          <span className="text-xs text-gray-400 flex-shrink-0">Desligar quando:</span>

          <Select
            value={rule.type}
            onValueChange={(v) => updateRule(rule.id, { type: v as DeactivationRule["type"], tag: undefined, field_key: undefined, field_value: undefined })}
          >
            <SelectTrigger className="w-44 h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="tag_added">Tag adicionada</SelectItem>
              <SelectItem value="tag_removed">Tag removida</SelectItem>
              <SelectItem value="custom_field_equals">Campo igual a</SelectItem>
            </SelectContent>
          </Select>

          {(rule.type === "tag_added" || rule.type === "tag_removed") && (
            <Select
              value={rule.tag || ""}
              onValueChange={(v) => updateRule(rule.id, { tag: v })}
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

          {rule.type === "custom_field_equals" && (
            <>
              <Select
                value={rule.field_key || ""}
                onValueChange={(v) => updateRule(rule.id, { field_key: v })}
              >
                <SelectTrigger className="w-36 h-8 text-xs">
                  <SelectValue placeholder="Campo..." />
                </SelectTrigger>
                <SelectContent>
                  {customFields.map((f) => (
                    <SelectItem key={f.id} value={f.fieldKey || f.id}>{f.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                value={rule.field_value || ""}
                onChange={(e) => updateRule(rule.id, { field_value: e.target.value })}
                placeholder="Valor..."
                className="flex-1 h-8 text-xs"
              />
            </>
          )}

          <button onClick={() => removeRule(rule.id)} className="text-gray-700 hover:text-red-500">
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      ))}

      <Button variant="outline" size="sm" onClick={addRule} className="w-full">
        <Plus className="w-3.5 h-3.5 mr-2" />
        Adicionar regra de desligamento
      </Button>
    </div>
  );
}
