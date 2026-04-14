"use client";

import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";

interface ToneSlidersProps {
  creativity: number;
  formality: number;
  naturalness: number;
  aggressiveness: number;
  onChange: (field: "tone_creativity" | "tone_formality" | "tone_naturalness" | "tone_aggressiveness", value: number) => void;
}

export function ToneSliders({ creativity, formality, naturalness, aggressiveness, onChange }: ToneSlidersProps) {
  return (
    <div className="space-y-6">
      {/* Naturalidade */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <Label>Naturalidade</Label>
          <span className="text-xs text-gray-500">{naturalness}%</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-gray-500 w-16">Robotico</span>
          <Slider
            value={[naturalness]}
            onValueChange={([v]) => onChange("tone_naturalness", v)}
            max={100}
            step={5}
            className="flex-1"
          />
          <span className="text-xs text-gray-500 w-16 text-right">Humano</span>
        </div>
        <p className="text-xs text-gray-500 mt-1.5">
          {naturalness < 20
            ? "Formal e estruturado. Mensagem unica com pontuacao completa."
            : naturalness < 40
            ? "Profissional. Mensagens bem escritas com pontuacao."
            : naturalness < 60
            ? "Equilibrado. Natural mas ainda polido."
            : naturalness < 80
            ? "Casual e humano. Pode dividir mensagens, usar abreviacoes (vc, tb, pfv)."
            : "Muito humano. Divide mensagens, sem ponto final, abreviacoes, digitacao espontanea."}
        </p>
        {naturalness >= 60 && (
          <div className="mt-2 text-[10px] text-gray-500 bg-gray-50 rounded-lg p-2.5 space-y-1">
            <p className="font-medium text-gray-400">Com naturalidade alta, a IA vai:</p>
            <ul className="list-disc list-inside space-y-0.5">
              <li>Dividir respostas em 2-3 mensagens separadas</li>
              <li>Usar abreviacoes: vc, tb, pfv, ta, blz</li>
              <li>Omitir ponto final nas frases</li>
              <li>Escrever de forma mais espontanea</li>
            </ul>
          </div>
        )}
      </div>

      {/* Criatividade */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <Label>Criatividade</Label>
          <span className="text-xs text-gray-500">{creativity}%</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-gray-500 w-16">Preciso</span>
          <Slider
            value={[creativity]}
            onValueChange={([v]) => onChange("tone_creativity", v)}
            max={100}
            step={5}
            className="flex-1"
          />
          <span className="text-xs text-gray-500 w-16 text-right">Criativo</span>
        </div>
        <p className="text-xs text-gray-500 mt-1.5">
          {creativity < 30
            ? "Respostas diretas e objetivas"
            : creativity < 70
            ? "Equilibrio entre objetividade e naturalidade"
            : "Respostas mais criativas e conversacionais"}
        </p>
      </div>

      {/* Formalidade */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <Label>Formalidade</Label>
          <span className="text-xs text-gray-500">{formality}%</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-gray-500 w-16">Informal</span>
          <Slider
            value={[formality]}
            onValueChange={([v]) => onChange("tone_formality", v)}
            max={100}
            step={5}
            className="flex-1"
          />
          <span className="text-xs text-gray-500 w-16 text-right">Formal</span>
        </div>
        <p className="text-xs text-gray-500 mt-1.5">
          {formality < 30
            ? "Tom casual, usa girias leves"
            : formality < 70
            ? "Tom profissional mas acessivel"
            : "Tom corporativo e formal"}
        </p>
      </div>

      {/* Agressividade */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <Label>Agressividade na venda</Label>
          <span className="text-xs text-gray-500">{aggressiveness}%</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-gray-500 w-16">Passivo</span>
          <Slider
            value={[aggressiveness]}
            onValueChange={([v]) => onChange("tone_aggressiveness", v)}
            max={100}
            step={5}
            className="flex-1"
          />
          <span className="text-xs text-gray-500 w-16 text-right">Agressivo</span>
        </div>
        <p className="text-xs text-gray-500 mt-1.5">
          {aggressiveness < 20
            ? "Passivo: so responde, nunca propoe agendamento proativamente"
            : aggressiveness < 40
            ? "Suave: sugere agendamento educadamente, aceita recusa sem insistir"
            : aggressiveness < 60
            ? "Equilibrado: propoe agendamento apos qualificacao, insiste uma vez"
            : aggressiveness < 80
            ? "Proativo: insiste 2x, cria senso de urgencia, destaca beneficios"
            : "Agressivo: insiste 3x, usa escassez, FOMO, rebate objecoes ativamente"}
        </p>
      </div>
    </div>
  );
}
