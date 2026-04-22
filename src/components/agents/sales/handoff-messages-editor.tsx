"use client";

import { useState } from "react";
import { Plus, Trash2, PowerOff, Pencil, Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import type { HandoffMessage } from "@/types/agent";

interface HandoffMessagesEditorProps {
  messages: HandoffMessage[];
  onChange: (messages: HandoffMessage[]) => void;
}

export function HandoffMessagesEditor({ messages, onChange }: HandoffMessagesEditorProps) {
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftLabel, setDraftLabel] = useState("");
  const [draftText, setDraftText] = useState("");
  const [draftAutoDeactivate, setDraftAutoDeactivate] = useState(true);

  const startAdd = () => {
    setAdding(true);
    setEditingId(null);
    setDraftLabel("");
    setDraftText("");
    setDraftAutoDeactivate(true);
  };

  const startEdit = (msg: HandoffMessage) => {
    setEditingId(msg.id);
    setAdding(false);
    setDraftLabel(msg.label);
    setDraftText(msg.text);
    setDraftAutoDeactivate(msg.auto_deactivate);
  };

  const cancel = () => {
    setAdding(false);
    setEditingId(null);
    setDraftLabel("");
    setDraftText("");
    setDraftAutoDeactivate(true);
  };

  const save = () => {
    if (!draftLabel.trim() || !draftText.trim()) return;

    if (editingId) {
      onChange(
        messages.map((m) =>
          m.id === editingId
            ? { ...m, label: draftLabel.trim(), text: draftText.trim(), auto_deactivate: draftAutoDeactivate }
            : m
        )
      );
    } else {
      const newMsg: HandoffMessage = {
        id: crypto.randomUUID(),
        label: draftLabel.trim(),
        text: draftText.trim(),
        auto_deactivate: draftAutoDeactivate,
      };
      onChange([...messages, newMsg]);
    }
    cancel();
  };

  const remove = (id: string) => {
    onChange(messages.filter((m) => m.id !== id));
  };

  const isEditingSomething = adding || editingId !== null;

  return (
    <div className="space-y-4">
      <p className="text-xs text-gray-400">
        Cadastre mensagens prontas que você envia manualmente ao cliente (pelo Spark
        ou pelo GHL) para encerrar o atendimento da IA. Quando a mensagem cadastrada
        aqui for detectada no envio saindo, a IA pausa automaticamente para aquele
        contato específico — outros contatos continuam sendo atendidos normalmente.
      </p>

      {/* Lista */}
      {messages.length > 0 && (
        <div className="space-y-2">
          {messages.map((msg) => {
            const isEditing = editingId === msg.id;

            if (isEditing) {
              return (
                <div key={msg.id} className="border border-gray-200 rounded-lg p-4 bg-gray-50 space-y-3">
                  <div>
                    <Label className="text-xs">Identificação</Label>
                    <Input
                      value={draftLabel}
                      onChange={(e) => setDraftLabel(e.target.value)}
                      placeholder="Ex: Encerramento padrão"
                      className="mt-1"
                    />
                  </div>
                  <div>
                    <Label className="text-xs">Texto exato da mensagem</Label>
                    <Textarea
                      value={draftText}
                      onChange={(e) => setDraftText(e.target.value)}
                      placeholder="Ex: Obrigada! A partir de agora eu sigo daqui com você pessoalmente."
                      rows={3}
                      className="mt-1"
                    />
                    <p className="text-[10px] text-gray-500 mt-1">
                      O sistema compara o texto enviado com este exato (ignorando espaços extras). Mantenha a mensagem curta e consistente.
                    </p>
                  </div>
                  <div className="flex items-center justify-between p-2 bg-gray-50 rounded border border-gray-200">
                    <div className="flex items-center gap-2">
                      <PowerOff className="w-3.5 h-3.5 text-red-500" />
                      <Label className="text-xs font-medium">Desativar IA ao enviar</Label>
                    </div>
                    <Switch
                      checked={draftAutoDeactivate}
                      onCheckedChange={setDraftAutoDeactivate}
                    />
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" onClick={save} disabled={!draftLabel.trim() || !draftText.trim()}>
                      <Check className="w-3.5 h-3.5 mr-1" /> Salvar
                    </Button>
                    <Button size="sm" variant="ghost" onClick={cancel}>
                      <X className="w-3.5 h-3.5 mr-1" /> Cancelar
                    </Button>
                  </div>
                </div>
              );
            }

            return (
              <div key={msg.id} className="border border-gray-200 rounded-lg p-3 bg-gray-50 group">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-sm font-medium text-gray-900 truncate">{msg.label}</span>
                      {msg.auto_deactivate ? (
                        <Badge variant="destructive" className="text-[10px] h-4 gap-1">
                          <PowerOff className="w-2.5 h-2.5" /> Desativa IA
                        </Badge>
                      ) : (
                        <Badge variant="secondary" className="text-[10px] h-4">
                          Apenas texto
                        </Badge>
                      )}
                    </div>
                    <p className="text-xs text-gray-700 line-clamp-2">&ldquo;{msg.text}&rdquo;</p>
                  </div>
                  <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button
                      onClick={() => startEdit(msg)}
                      className="text-gray-700 hover:text-gray-800 transition-colors"
                      title="Editar"
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => remove(msg.id)}
                      className="text-gray-700 hover:text-red-500 transition-colors"
                      title="Apagar"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Adicionar */}
      {adding ? (
        <div className="border border-gray-200 rounded-lg p-4 bg-gray-50 space-y-3">
          <div>
            <Label className="text-xs">Identificação</Label>
            <Input
              value={draftLabel}
              onChange={(e) => setDraftLabel(e.target.value)}
              placeholder="Ex: Encerramento padrão"
              className="mt-1"
            />
          </div>
          <div>
            <Label className="text-xs">Texto exato da mensagem</Label>
            <Textarea
              value={draftText}
              onChange={(e) => setDraftText(e.target.value)}
              placeholder="Ex: Obrigada! A partir de agora eu sigo daqui com você pessoalmente."
              rows={3}
              className="mt-1"
            />
            <p className="text-[10px] text-gray-500 mt-1">
              O sistema compara o texto enviado com este exato (ignorando espaços extras). Mantenha a mensagem curta e consistente.
            </p>
          </div>
          <div className="flex items-center justify-between p-2 bg-gray-50 rounded border border-gray-200">
            <div className="flex items-center gap-2">
              <PowerOff className="w-3.5 h-3.5 text-red-500" />
              <Label className="text-xs font-medium">Desativar IA ao enviar</Label>
            </div>
            <Switch
              checked={draftAutoDeactivate}
              onCheckedChange={setDraftAutoDeactivate}
            />
          </div>
          <div className="flex gap-2">
            <Button size="sm" onClick={save} disabled={!draftLabel.trim() || !draftText.trim()}>
              <Check className="w-3.5 h-3.5 mr-1" /> Adicionar
            </Button>
            <Button size="sm" variant="ghost" onClick={cancel}>
              <X className="w-3.5 h-3.5 mr-1" /> Cancelar
            </Button>
          </div>
        </div>
      ) : (
        !isEditingSomething && (
          <Button variant="outline" size="sm" onClick={startAdd} className="w-full">
            <Plus className="w-3.5 h-3.5 mr-2" />
            Adicionar mensagem de encerramento
          </Button>
        )
      )}

      {messages.length === 0 && !adding && (
        <p className="text-xs text-gray-500 text-center py-2">
          Nenhuma mensagem de encerramento cadastrada.
        </p>
      )}
    </div>
  );
}
