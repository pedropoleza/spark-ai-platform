"use client";

import { Bot, User } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils/cn";
import type { AgentPersonality } from "@/types/agent";

interface PersonalityEditorProps {
  personality: AgentPersonality;
  onChange: (personality: AgentPersonality) => void;
}

export function PersonalityEditor({ personality, onChange }: PersonalityEditorProps) {
  const update = <K extends keyof AgentPersonality>(key: K, value: AgentPersonality[K]) => {
    onChange({ ...personality, [key]: value });
  };

  return (
    <div className="space-y-6">
      {/* Nome + idioma */}
      <div className="grid grid-cols-2 gap-4">
        <div>
          <Label>Nome da IA</Label>
          <Input
            value={personality.name}
            onChange={(e) => update("name", e.target.value)}
            placeholder="Ex: Ana, Spark, Julia"
            className="mt-1.5"
          />
          <p className="text-xs text-neutral-400 mt-1">
            Como a IA se identifica nas conversas
          </p>
        </div>
        <div>
          <Label>Idioma</Label>
          <Select value={personality.language} onValueChange={(v) => update("language", v)}>
            <SelectTrigger className="mt-1.5">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="pt-BR">Portugues (Brasil)</SelectItem>
              <SelectItem value="en-US">English (US)</SelectItem>
              <SelectItem value="es">Espanol</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Identidade */}
      <div>
        <Label className="mb-3 block">Identidade</Label>
        <div className="grid grid-cols-2 gap-3">
          <IdentityCard
            icon={Bot}
            label="Assistente virtual"
            description="Se apresenta como assistente/IA da empresa"
            example={`"Oi! Sou a ${personality.name || "IA"}, assistente virtual da empresa."`}
            selected={personality.identity_mode === "assistant"}
            onClick={() => update("identity_mode", "assistant")}
          />
          <IdentityCard
            icon={User}
            label="Atendente humano"
            description="Se comporta como uma pessoa real da equipe"
            example={`"Oi! Sou a ${personality.name || "Ana"}, da equipe de atendimento."`}
            selected={personality.identity_mode === "human"}
            onClick={() => update("identity_mode", "human")}
          />
        </div>
      </div>

      {/* Cumprimento e despedida */}
      <div className="grid grid-cols-2 gap-4">
        <div>
          <Label>Estilo de cumprimento</Label>
          <Input
            value={personality.greeting_style}
            onChange={(e) => update("greeting_style", e.target.value)}
            placeholder="Ex: Oi {name}! Tudo bem?"
            className="mt-1.5"
          />
          <p className="text-xs text-neutral-400 mt-1">
            Use {"{name}"} para o nome do contato
          </p>
        </div>
        <div>
          <Label>Estilo de despedida</Label>
          <Input
            value={personality.farewell_style}
            onChange={(e) => update("farewell_style", e.target.value)}
            placeholder="Ex: Qualquer duvida, estou por aqui!"
            className="mt-1.5"
          />
        </div>
      </div>

      {/* Descricao da personalidade */}
      <div>
        <Label>Descricao da personalidade</Label>
        <Textarea
          value={personality.persona_description}
          onChange={(e) => update("persona_description", e.target.value)}
          placeholder={`Descreva a personalidade da IA. Ex:\n- Simpatica e acolhedora\n- Profissional mas descontraida\n- Especialista em seguros de vida\n- Sempre positiva, nunca pressiona o cliente`}
          rows={4}
          className="mt-1.5"
        />
        <p className="text-xs text-neutral-400 mt-1">
          Quanto mais detalhada a descricao, mais consistente sera o comportamento
        </p>
      </div>
    </div>
  );
}

function IdentityCard({
  icon: Icon,
  label,
  description,
  example,
  selected,
  onClick,
}: {
  icon: typeof Bot;
  label: string;
  description: string;
  example: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex flex-col items-start gap-2 p-4 border-2 rounded-xl text-left transition-all",
        selected ? "border-neutral-900 bg-neutral-50" : "border-neutral-200 hover:border-neutral-300"
      )}
    >
      <Icon className={cn("w-5 h-5", selected ? "text-neutral-900" : "text-neutral-400")} />
      <span className={cn("text-sm font-medium", selected ? "text-neutral-900" : "text-neutral-700")}>
        {label}
      </span>
      <span className="text-xs text-neutral-500">{description}</span>
      <span className="text-[10px] text-neutral-400 italic mt-1">{example}</span>
    </button>
  );
}
