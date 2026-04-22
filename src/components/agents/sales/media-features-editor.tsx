"use client";

import { Mic, Eye, FileText, StickyNote } from "lucide-react";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";

interface MediaFeaturesEditorProps {
  enableAudio: boolean;
  enableImage: boolean;
  enablePdf: boolean;
  enableSummaryNotes: boolean;
  onChangeAudio: (v: boolean) => void;
  onChangeImage: (v: boolean) => void;
  onChangePdf: (v: boolean) => void;
  onChangeSummaryNotes: (v: boolean) => void;
}

const features = [
  {
    key: "audio" as const,
    icon: Mic,
    label: "Transcrição de áudio",
    description: "A IA ouve e transcreve áudios enviados pelo contato, respondendo com base no conteúdo falado.",
    cost: "~$0.006/min",
    model: "Whisper",
  },
  {
    key: "image" as const,
    icon: Eye,
    label: "Análise de imagens",
    description: "A IA analisa fotos e imagens enviadas, descrevendo o conteúdo e respondendo contextualmente.",
    cost: "~$0.001-0.003/img",
    model: "GPT-4 Vision",
  },
  {
    key: "pdf" as const,
    icon: FileText,
    label: "Leitura de documentos",
    description: "A IA extrai texto de PDFs e documentos Word enviados, usando o conteúdo para responder perguntas.",
    cost: "~$0.002-0.01/doc",
    model: "Extração + GPT",
  },
  {
    key: "summary" as const,
    icon: StickyNote,
    label: "Notas de resumo automáticas",
    description: "Ao encerrar um atendimento, a IA gera uma nota profissional no contato do GHL com resumo, dados coletados e próximos passos.",
    cost: "~$0.001/nota",
    model: "GPT/Claude",
  },
];

export function MediaFeaturesEditor({
  enableAudio,
  enableImage,
  enablePdf,
  enableSummaryNotes,
  onChangeAudio,
  onChangeImage,
  onChangePdf,
  onChangeSummaryNotes,
}: MediaFeaturesEditorProps) {
  const values = { audio: enableAudio, image: enableImage, pdf: enablePdf, summary: enableSummaryNotes };
  const handlers = { audio: onChangeAudio, image: onChangeImage, pdf: onChangePdf, summary: onChangeSummaryNotes };

  return (
    <div className="space-y-3">
      {features.map((f) => {
        const Icon = f.icon;
        const enabled = values[f.key];
        return (
          <div
            key={f.key}
            className={`flex items-start justify-between gap-4 p-4 rounded-xl border transition-all duration-200 ${
              enabled
                ? "border-brand-200 bg-brand-50/40"
                : "border-gray-200 bg-gray-50/40"
            }`}
          >
            <div className="flex gap-3 flex-1">
              <div className={`w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 ${
                enabled ? "bg-brand-100 text-brand-600" : "bg-gray-100 text-gray-400"
              }`}>
                <Icon className="w-4.5 h-4.5" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-0.5">
                  <Label className="text-sm font-semibold text-gray-900">{f.label}</Label>
                  <Badge variant="secondary" className="text-[9px] font-normal">
                    {f.cost}
                  </Badge>
                </div>
                <p className="text-sm text-gray-600 leading-relaxed">{f.description}</p>
                <p className="text-[10px] text-gray-400 mt-1">Modelo: {f.model}</p>
              </div>
            </div>
            <Switch
              checked={enabled}
              onCheckedChange={handlers[f.key]}
            />
          </div>
        );
      })}
    </div>
  );
}
