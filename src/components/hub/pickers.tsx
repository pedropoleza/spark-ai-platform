/**
 * Pickers dinâmicos do Spark Leads (F35, Pedro 2026-05-28).
 *
 * Hoje rep tinha que digitar IDs (pipeline_stage_id, custom_field_key) ou
 * tag-name de memória nos editores de Ativação. UX ruim e propenso a erro.
 * Aqui ficam 3 pickers que puxam da API GHL e oferecem autocomplete/select:
 *  - TagPicker:           1 tag via combobox (datalist autocomplete)
 *  - TagsMultiPicker:     N tags via chips + add
 *  - PipelineStagePicker: 2 selects cascading (funil → etapa)
 *  - CustomFieldPicker:   campo via select + valor via input
 *
 * Cada um:
 *  - faz fetch único + cache local 5min (evita N reqs por edit)
 *  - tem loading state
 *  - fail-soft: se API offline, vira input texto livre (não-bloqueante)
 *
 * Endpoints (já existentes):
 *  - GET /api/ghl/tags          → { tags: [{id,name}|string] }
 *  - GET /api/ghl/pipelines     → { pipelines: [{id,name,stages:[{id,name}]}] }
 *  - GET /api/ghl/custom-fields → { customFields: [{id,name,fieldKey,dataType,isStandard}] }
 */
"use client";

import { useEffect, useState } from "react";
import { Plus, Trash2, X } from "lucide-react";

const CACHE_TTL_MS = 5 * 60 * 1000;
type CacheEntry<T> = { value: T; expiresAt: number };
const cache = new Map<string, CacheEntry<unknown>>();

async function cachedFetch<T>(url: string, fallback: T): Promise<T> {
  const hit = cache.get(url) as CacheEntry<T> | undefined;
  if (hit && hit.expiresAt > Date.now()) return hit.value;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status}`);
    const data = (await res.json()) as T;
    cache.set(url, { value: data, expiresAt: Date.now() + CACHE_TTL_MS });
    return data;
  } catch {
    return fallback;
  }
}

interface GhlTag {
  id?: string;
  name?: string;
}
interface GhlStage {
  id: string;
  name: string;
}
interface GhlPipeline {
  id: string;
  name: string;
  stages?: GhlStage[];
}
interface GhlCustomField {
  id: string;
  name?: string;
  fieldKey?: string;
  dataType?: string;
  isStandard?: boolean;
}

/* ─────────────────────────── TagPicker ─────────────────────────── */

export function TagPicker({
  value,
  onChange,
  placeholder = "Tag…",
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  const [tags, setTags] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [degraded, setDegraded] = useState(false);

  useEffect(() => {
    cachedFetch<{ tags?: (GhlTag | string)[] }>("/api/ghl/tags", { tags: [] })
      .then((d) => {
        const arr = (d.tags || [])
          .map((t) => (typeof t === "string" ? t : t?.name || t?.id || ""))
          .filter((s): s is string => !!s)
          .sort((a, b) => a.localeCompare(b));
        setTags(Array.from(new Set(arr)));
        if (arr.length === 0) setDegraded(true);
      })
      .catch(() => setDegraded(true))
      .finally(() => setLoaded(true));
  }, []);

  const listId = "ghl-tags-list";
  return (
    <>
      <input
        className="input grow"
        list={degraded ? undefined : listId}
        value={value}
        onChange={(ev) => onChange(ev.target.value)}
        placeholder={loaded ? (degraded ? `${placeholder} (digite manual)` : placeholder) : "carregando tags…"}
        disabled={!loaded}
      />
      {!degraded && (
        <datalist id={listId}>
          {tags.map((t) => (
            <option key={t} value={t} />
          ))}
        </datalist>
      )}
    </>
  );
}

/* ──────────────────────── TagsMultiPicker ──────────────────────── */

export function TagsMultiPicker({
  values,
  onChange,
}: {
  values: string[];
  onChange: (next: string[]) => void;
}) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const v = draft.trim();
    if (!v || values.includes(v)) {
      setDraft("");
      return;
    }
    onChange([...values, v]);
    setDraft("");
  };
  const remove = (t: string) => onChange(values.filter((x) => x !== t));
  return (
    <div className="col" style={{ gap: 8 }}>
      <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
        {values.length === 0 && (
          <div className="muted" style={{ fontSize: 12.5 }}>
            Nenhuma tag — adicione pelo menos 1.
          </div>
        )}
        {values.map((t) => (
          <span
            key={t}
            className="row"
            style={{
              gap: 4,
              alignItems: "center",
              background: "var(--surface-2)",
              border: "1px solid var(--border)",
              borderRadius: 999,
              padding: "3px 10px",
              fontSize: 12.5,
            }}
          >
            {t}
            <button
              type="button"
              onClick={() => remove(t)}
              aria-label={`Remover ${t}`}
              style={{
                background: "transparent",
                border: "none",
                cursor: "pointer",
                color: "var(--ink-4)",
                display: "inline-flex",
              }}
            >
              <X size={12} />
            </button>
          </span>
        ))}
      </div>
      <div className="row" style={{ gap: 6 }}>
        <TagPicker value={draft} onChange={setDraft} placeholder="adicionar tag…" />
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={add}
          disabled={!draft.trim()}
        >
          <Plus size={12} /> Adicionar
        </button>
      </div>
    </div>
  );
}

/* ──────────────────── PipelineStagePicker ──────────────────── */

export function PipelineStagePicker({
  pipelineId,
  stageId,
  onChange,
}: {
  pipelineId: string;
  stageId: string;
  onChange: (next: { pipeline_id: string; pipeline_stage_id: string }) => void;
}) {
  const [pipelines, setPipelines] = useState<GhlPipeline[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [degraded, setDegraded] = useState(false);

  useEffect(() => {
    cachedFetch<{ pipelines?: GhlPipeline[] }>("/api/ghl/pipelines", { pipelines: [] })
      .then((d) => {
        const arr = (d.pipelines || []).filter((p) => p?.id);
        setPipelines(arr);
        if (arr.length === 0) setDegraded(true);
      })
      .catch(() => setDegraded(true))
      .finally(() => setLoaded(true));
  }, []);

  if (degraded || (loaded && pipelines.length === 0)) {
    return (
      <>
        <input
          className="input"
          value={pipelineId}
          onChange={(ev) => onChange({ pipeline_id: ev.target.value, pipeline_stage_id: stageId })}
          placeholder="ID do funil (API offline — digite)"
          style={{ width: 200 }}
        />
        <input
          className="input grow"
          value={stageId}
          onChange={(ev) => onChange({ pipeline_id: pipelineId, pipeline_stage_id: ev.target.value })}
          placeholder="ID da etapa"
        />
      </>
    );
  }

  const selectedPipeline = pipelines.find((p) => p.id === pipelineId);
  const stages = selectedPipeline?.stages || [];

  return (
    <>
      <select
        className="select"
        value={pipelineId}
        onChange={(ev) => onChange({ pipeline_id: ev.target.value, pipeline_stage_id: "" })}
        disabled={!loaded}
        style={{ minWidth: 180 }}
        aria-label="Funil"
      >
        <option value="">{loaded ? "Escolha o funil…" : "carregando…"}</option>
        {pipelines.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name || p.id}
          </option>
        ))}
      </select>
      <select
        className="select grow"
        value={stageId}
        onChange={(ev) => onChange({ pipeline_id: pipelineId, pipeline_stage_id: ev.target.value })}
        disabled={!loaded || !pipelineId}
        style={{ minWidth: 180 }}
        aria-label="Etapa"
      >
        <option value="">
          {!pipelineId ? "escolha funil primeiro" : stages.length ? "Escolha a etapa…" : "sem etapas"}
        </option>
        {stages.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name || s.id}
          </option>
        ))}
      </select>
    </>
  );
}

/* ─────────────────── CustomFieldPicker ─────────────────── */

export function CustomFieldPicker({
  fieldKey,
  fieldValue,
  onChange,
}: {
  fieldKey: string;
  fieldValue: string;
  onChange: (next: { custom_field_key: string; custom_field_value: string }) => void;
}) {
  const [fields, setFields] = useState<GhlCustomField[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [degraded, setDegraded] = useState(false);

  useEffect(() => {
    cachedFetch<{ customFields?: GhlCustomField[] }>("/api/ghl/custom-fields", { customFields: [] })
      .then((d) => {
        const arr = (d.customFields || []).filter((f) => f?.id);
        setFields(arr);
        if (arr.length === 0) setDegraded(true);
      })
      .catch(() => setDegraded(true))
      .finally(() => setLoaded(true));
  }, []);

  if (degraded || (loaded && fields.length === 0)) {
    return (
      <>
        <input
          className="input"
          value={fieldKey}
          onChange={(ev) => onChange({ custom_field_key: ev.target.value, custom_field_value: fieldValue })}
          placeholder="chave do campo (API offline — digite)"
          style={{ width: 200 }}
        />
        <input
          className="input grow"
          value={fieldValue}
          onChange={(ev) => onChange({ custom_field_key: fieldKey, custom_field_value: ev.target.value })}
          placeholder="valor (vazio = qualquer)"
        />
      </>
    );
  }

  // O valor que salvamos pode ser id ou fieldKey conforme schema GHL — preferimos
  // o que o usuário escolheu via select (preservando retrocompat).
  return (
    <>
      <select
        className="select"
        value={fieldKey}
        onChange={(ev) => onChange({ custom_field_key: ev.target.value, custom_field_value: fieldValue })}
        disabled={!loaded}
        style={{ minWidth: 220 }}
        aria-label="Campo personalizado"
      >
        <option value="">{loaded ? "Escolha o campo…" : "carregando…"}</option>
        <optgroup label="Padrão">
          {fields.filter((f) => f.isStandard).map((f) => (
            <option key={f.id} value={f.fieldKey || f.id}>
              {f.name || f.fieldKey || f.id}
            </option>
          ))}
        </optgroup>
        <optgroup label="Personalizados">
          {fields.filter((f) => !f.isStandard).map((f) => (
            <option key={f.id} value={f.fieldKey || f.id}>
              {f.name || f.fieldKey || f.id}
            </option>
          ))}
        </optgroup>
      </select>
      <input
        className="input grow"
        value={fieldValue}
        onChange={(ev) => onChange({ custom_field_key: fieldKey, custom_field_value: ev.target.value })}
        placeholder="valor (vazio = qualquer)"
      />
    </>
  );
}

// Re-exports utilitários pra evitar warning de unused imports caso o consumer não use.
export { Plus, Trash2 };
