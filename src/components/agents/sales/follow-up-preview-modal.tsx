"use client";

import { useState, useEffect } from "react";
import { X, Loader2, RotateCw, Copy, Check, MessageSquarePlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Card, CardContent } from "@/components/ui/card";

// 5 tentativas padrão pro modo ai_auto. A config do agente pode sobrescrever
// com manual_steps; nesse caso usamos o count das steps configuradas.
const DEFAULT_ATTEMPTS = [
  { num: 1, label: "#1 · lembrete leve" },
  { num: 2, label: "#2 · retomada direta" },
  { num: 3, label: "#3 · urgência / prova social" },
  { num: 4, label: "#4 · último toque educado" },
  { num: 5, label: "#5 · opt-out suave" },
];

interface FollowUpConfig {
  enabled?: boolean;
  mode?: "ai_auto" | "manual";
  manual_steps?: { delay_minutes: number; custom_message?: string }[];
}

interface FollowUpPreviewModalProps {
  agentId: string;
  sessionId: string | null;
  contactId: string;
  followUpConfig?: FollowUpConfig;
  onClose: () => void;
  onAdded: (content: string) => void;
}

export function FollowUpPreviewModal({
  agentId,
  sessionId,
  contactId,
  followUpConfig,
  onClose,
  onAdded,
}: FollowUpPreviewModalProps) {
  const isManual = followUpConfig?.mode === "manual";
  const steps = isManual && followUpConfig?.manual_steps
    ? followUpConfig.manual_steps.map((s, i) => ({
        num: i + 1,
        label: s.custom_message
          ? `#${i + 1} · ${s.delay_minutes}min — "${s.custom_message.substring(0, 40)}${s.custom_message.length > 40 ? "…" : ""}"`
          : `#${i + 1} · ${s.delay_minutes}min · (será gerado por IA)`,
      }))
    : DEFAULT_ATTEMPTS;

  const [attemptNumber, setAttemptNumber] = useState(1);
  const [generatedMessage, setGeneratedMessage] = useState("");
  const [editedMessage, setEditedMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [meta, setMeta] = useState<{ duration_ms?: number; tokens?: number; mode?: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [adding, setAdding] = useState(false);

  const generate = async () => {
    setLoading(true);
    setError(null);
    setMeta(null);
    try {
      const res = await fetch("/api/agents/test/followup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agent_id: agentId,
          session_id: sessionId,
          attempt_number: attemptNumber,
          contact_id: contactId || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Falha ao gerar follow-up");
        return;
      }
      setGeneratedMessage(data.message);
      setEditedMessage(data.message);
      setMeta({
        duration_ms: data.duration_ms,
        tokens: (data.prompt_tokens || 0) + (data.completion_tokens || 0),
        mode: data.mode,
      });
    } catch {
      setError("Erro de conexão");
    } finally {
      setLoading(false);
    }
  };

  // Gera automaticamente ao abrir e quando muda o número da tentativa
  useEffect(() => {
    generate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attemptNumber]);

  const copyToClipboard = async () => {
    await navigator.clipboard.writeText(editedMessage);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const addToConversation = async () => {
    if (!sessionId || !editedMessage.trim()) return;
    setAdding(true);
    try {
      const res = await fetch(`/api/agents/test/sessions/${sessionId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          role: "agent",
          content: editedMessage,
          metadata: { is_followup: true, attempt_number: attemptNumber },
        }),
      });
      if (!res.ok) {
        const data = await res.json();
        setError(data.error || "Falha ao adicionar à conversa");
        return;
      }
      onAdded(editedMessage);
      onClose();
    } catch {
      setError("Erro de conexão ao adicionar");
    } finally {
      setAdding(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <Card
        className="w-full max-w-xl max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b">
          <div>
            <h3 className="font-semibold text-gray-900">Prévia de Follow-up</h3>
            <p className="text-xs text-gray-500 mt-0.5">
              Veja e ajuste a mensagem que o cron enviaria em produção
            </p>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} className="h-8 w-8">
            <X className="w-4 h-4" />
          </Button>
        </div>

        <CardContent className="p-4 overflow-y-auto flex-1 space-y-3">
          <div>
            <Label className="text-xs text-gray-600">Tentativa</Label>
            <Select
              value={String(attemptNumber)}
              onValueChange={(v) => setAttemptNumber(parseInt(v, 10))}
            >
              <SelectTrigger className="mt-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {steps.map((s) => (
                  <SelectItem key={s.num} value={String(s.num)}>
                    {s.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {isManual && (
              <p className="text-xs text-gray-400 mt-1">
                Modo manual · mensagem vem do passo configurado (não usa IA)
              </p>
            )}
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <Label className="text-xs text-gray-600">Mensagem gerada (editável)</Label>
              {meta && (
                <span className="text-xs text-gray-400">
                  {meta.mode === "manual" ? "fixo" : `${meta.tokens || 0} tokens`}
                  {meta.duration_ms ? ` · ${(meta.duration_ms / 1000).toFixed(1)}s` : ""}
                </span>
              )}
            </div>
            {loading ? (
              <div className="border rounded-md p-4 flex items-center justify-center text-sm text-gray-500 h-32">
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Gerando...
              </div>
            ) : error ? (
              <div className="border border-red-200 bg-red-50 rounded-md p-3 text-sm text-red-700">
                {error}
              </div>
            ) : (
              <Textarea
                value={editedMessage}
                onChange={(e) => setEditedMessage(e.target.value)}
                rows={6}
                className="text-sm"
                placeholder="Mensagem do follow-up..."
              />
            )}
          </div>

          {!loading && editedMessage !== generatedMessage && generatedMessage && (
            <p className="text-xs text-amber-600">
              Mensagem editada. O botão Adicionar à conversa vai usar sua versão.
            </p>
          )}
        </CardContent>

        <div className="flex items-center gap-2 p-4 border-t bg-gray-50 rounded-b-lg">
          <Button
            variant="outline"
            size="sm"
            onClick={generate}
            disabled={loading || meta?.mode === "manual"}
            title="Gerar nova variação via IA"
          >
            <RotateCw className={`w-4 h-4 mr-1.5 ${loading ? "animate-spin" : ""}`} />
            Regenerar
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={copyToClipboard}
            disabled={!editedMessage}
          >
            {copied ? <Check className="w-4 h-4 mr-1.5 text-green-600" /> : <Copy className="w-4 h-4 mr-1.5" />}
            {copied ? "Copiado" : "Copiar"}
          </Button>
          <div className="flex-1" />
          <Button
            size="sm"
            onClick={addToConversation}
            disabled={!sessionId || !editedMessage.trim() || adding || loading}
          >
            <MessageSquarePlus className="w-4 h-4 mr-1.5" />
            {adding ? "Adicionando..." : "Adicionar à conversa"}
          </Button>
        </div>
      </Card>
    </div>
  );
}
