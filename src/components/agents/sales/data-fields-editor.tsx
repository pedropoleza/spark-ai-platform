"use client";

import { useState } from "react";
import { ChevronUp, ChevronDown, Trash2, Plus, Database, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { DataField } from "@/types/agent";

interface GHLCustomField {
  id: string;
  name: string;
  fieldKey: string;
  dataType: string;
  isStandard?: boolean;
}

interface DataFieldsEditorProps {
  fields: DataField[];
  customFields: GHLCustomField[];
  onChange: (fields: DataField[]) => void;
}

export function DataFieldsEditor({
  fields,
  customFields,
  onChange,
}: DataFieldsEditorProps) {
  const [showAddForm, setShowAddForm] = useState(false);
  const [addMode, setAddMode] = useState<"custom_field" | "simple" | null>(null);
  const [newField, setNewField] = useState<DataField>({
    key: "",
    label: "",
    required: true,
    type: "text",
  });
  const [selectedGHLField, setSelectedGHLField] = useState<string>("");

  const handleRemove = (index: number) => {
    onChange(fields.filter((_, i) => i !== index));
  };

  const handleToggleRequired = (index: number) => {
    onChange(
      fields.map((f, i) => (i === index ? { ...f, required: !f.required } : f))
    );
  };

  const handleToggleSkipIfFilled = (index: number) => {
    onChange(
      fields.map((f, i) => (i === index ? { ...f, skip_if_filled: !f.skip_if_filled } : f))
    );
  };

  const handleMoveUp = (index: number) => {
    if (index === 0) return;
    const updated = [...fields];
    [updated[index - 1], updated[index]] = [updated[index], updated[index - 1]];
    onChange(updated);
  };

  const handleMoveDown = (index: number) => {
    if (index === fields.length - 1) return;
    const updated = [...fields];
    [updated[index], updated[index + 1]] = [updated[index + 1], updated[index]];
    onChange(updated);
  };

  const handleAddCustomField = () => {
    const ghlField = customFields.find((f) => f.id === selectedGHLField);
    if (!ghlField) return;

    onChange([
      ...fields,
      {
        key: ghlField.id,
        label: ghlField.name,
        required: true,
        type: mapGHLType(ghlField.dataType),
        ghl_field_id: ghlField.id,
        ghl_field_key: ghlField.fieldKey,
        sync_to_ghl: true,
      },
    ]);
    resetAddForm();
  };

  const handleAddSimpleField = () => {
    if (!newField.label) return;
    const key =
      newField.key ||
      newField.label
        .toLowerCase()
        .replace(/\s+/g, "_")
        .replace(/[^a-z0-9_]/g, "");

    onChange([
      ...fields,
      { ...newField, key, sync_to_ghl: false },
    ]);
    resetAddForm();
  };

  const resetAddForm = () => {
    setShowAddForm(false);
    setAddMode(null);
    setNewField({ key: "", label: "", required: true, type: "text" });
    setSelectedGHLField("");
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <Label>Campos para coletar</Label>
        <span className="text-xs text-neutral-400">{fields.length} campos</span>
      </div>

      {/* Lista de campos */}
      <div className="space-y-2">
        {fields.map((field, index) => (
          <div
            key={`${field.key}-${index}`}
            className="flex items-center gap-3 p-3 bg-white border border-neutral-200 rounded-lg group"
          >
            <div className="flex flex-col gap-0.5">
              <button
                type="button"
                className="text-neutral-300 hover:text-neutral-500 disabled:opacity-20"
                onClick={() => handleMoveUp(index)}
                disabled={index === 0}
              >
                <ChevronUp className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                className="text-neutral-300 hover:text-neutral-500 disabled:opacity-20"
                onClick={() => handleMoveDown(index)}
                disabled={index === fields.length - 1}
              >
                <ChevronDown className="w-3.5 h-3.5" />
              </button>
            </div>

            <div className="flex-1 min-w-0">
              <span className="text-sm font-medium text-neutral-900 block truncate">
                {field.label}
              </span>
              <span className="text-xs text-neutral-400">{field.key}</span>
            </div>

            {field.sync_to_ghl ? (
              <Badge variant="default" className="text-[10px] gap-1">
                <Database className="w-3 h-3" />
                Custom Field
              </Badge>
            ) : (
              <Badge variant="secondary" className="text-[10px] gap-1">
                <FileText className="w-3 h-3" />
                Simples
              </Badge>
            )}

            <span className="text-xs text-neutral-400 px-2 py-0.5 bg-neutral-100 rounded">
              {field.type}
            </span>

            <div className="flex items-center gap-1.5" title="Campo obrigatorio">
              <span className="text-xs text-neutral-400">Obrig.</span>
              <Switch
                checked={field.required}
                onCheckedChange={() => handleToggleRequired(index)}
                className="scale-75"
              />
            </div>

            <div className="flex items-center gap-1.5" title="Pular se ja estiver preenchido no contato">
              <span className="text-xs text-neutral-400">Pular se preenchido</span>
              <Switch
                checked={field.skip_if_filled ?? true}
                onCheckedChange={() => handleToggleSkipIfFilled(index)}
                className="scale-75"
              />
            </div>

            <button
              type="button"
              onClick={() => handleRemove(index)}
              className="text-neutral-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        ))}
      </div>

      {/* Adicionar campo */}
      {showAddForm ? (
        <div className="p-4 border border-neutral-200 rounded-lg bg-neutral-50 space-y-4">
          {!addMode ? (
            <div className="grid grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => setAddMode("custom_field")}
                className="flex flex-col items-center gap-2 p-4 border-2 border-neutral-200 rounded-lg hover:border-neutral-400 transition-colors"
              >
                <Database className="w-5 h-5 text-neutral-600" />
                <span className="text-sm font-medium">Custom Field</span>
                <span className="text-xs text-neutral-400 text-center">
                  Vincula a um campo do Spark e atualiza automaticamente
                </span>
              </button>
              <button
                type="button"
                onClick={() => setAddMode("simple")}
                className="flex flex-col items-center gap-2 p-4 border-2 border-neutral-200 rounded-lg hover:border-neutral-400 transition-colors"
              >
                <FileText className="w-5 h-5 text-neutral-600" />
                <span className="text-sm font-medium">Campo simples</span>
                <span className="text-xs text-neutral-400 text-center">
                  Coleta a informacao mas nao atualiza no sistema
                </span>
              </button>
            </div>
          ) : addMode === "custom_field" ? (
            <div className="space-y-3">
              <div>
                <Label className="text-xs">Selecione o Custom Field</Label>
                <Select value={selectedGHLField} onValueChange={setSelectedGHLField}>
                  <SelectTrigger className="mt-1">
                    <SelectValue placeholder="Escolha um campo..." />
                  </SelectTrigger>
                  <SelectContent>
                    {customFields.filter((f) => f.isStandard).length > 0 && (
                      <>
                        <div className="px-2 py-1.5 text-xs font-semibold text-neutral-400">
                          Campos padrao
                        </div>
                        {customFields
                          .filter((f) => f.isStandard)
                          .map((f) => (
                            <SelectItem key={f.id} value={f.id}>
                              {f.name}
                            </SelectItem>
                          ))}
                      </>
                    )}
                    {customFields.filter((f) => !f.isStandard).length > 0 && (
                      <>
                        <div className="px-2 py-1.5 text-xs font-semibold text-neutral-400 mt-1">
                          Custom Fields
                        </div>
                        {customFields
                          .filter((f) => !f.isStandard)
                          .map((f) => (
                            <SelectItem key={f.id} value={f.id}>
                              {f.name} ({f.dataType})
                            </SelectItem>
                          ))}
                      </>
                    )}
                  </SelectContent>
                </Select>
                <p className="text-xs text-neutral-400 mt-1">
                  A IA vai atualizar este campo no contato automaticamente
                </p>
              </div>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  onClick={handleAddCustomField}
                  disabled={!selectedGHLField}
                >
                  Adicionar
                </Button>
                <Button size="sm" variant="ghost" onClick={resetAddForm}>
                  Cancelar
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="text-xs">Nome do campo</Label>
                  <Input
                    value={newField.label}
                    onChange={(e) =>
                      setNewField({
                        ...newField,
                        label: e.target.value,
                        key: e.target.value
                          .toLowerCase()
                          .replace(/\s+/g, "_")
                          .replace(/[^a-z0-9_]/g, ""),
                      })
                    }
                    placeholder="Ex: Renda mensal"
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label className="text-xs">Tipo</Label>
                  <Select
                    value={newField.type}
                    onValueChange={(v) =>
                      setNewField({
                        ...newField,
                        type: v as DataField["type"],
                      })
                    }
                  >
                    <SelectTrigger className="mt-1">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="text">Texto</SelectItem>
                      <SelectItem value="date">Data</SelectItem>
                      <SelectItem value="boolean">Sim/Nao</SelectItem>
                      <SelectItem value="select">Selecao</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  onClick={handleAddSimpleField}
                  disabled={!newField.label}
                >
                  Adicionar
                </Button>
                <Button size="sm" variant="ghost" onClick={resetAddForm}>
                  Cancelar
                </Button>
              </div>
            </div>
          )}
        </div>
      ) : (
        <Button
          variant="outline"
          size="sm"
          onClick={() => setShowAddForm(true)}
          className="w-full"
        >
          <Plus className="w-3.5 h-3.5 mr-2" />
          Adicionar campo
        </Button>
      )}
    </div>
  );
}

function mapGHLType(dataType: string): DataField["type"] {
  switch (dataType?.toLowerCase()) {
    case "date":
      return "date";
    case "checkbox":
    case "boolean":
      return "boolean";
    case "dropdown":
    case "select":
    case "radio":
      return "select";
    default:
      return "text";
  }
}
