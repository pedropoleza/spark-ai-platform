"use client";

import { useState, useEffect } from "react";

interface GHLPipeline {
  id: string;
  name: string;
  stages: { id: string; name: string; position: number }[];
}

interface GHLCalendar {
  id: string;
  name: string;
  isActive?: boolean;
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

interface GHLData {
  pipelines: GHLPipeline[];
  calendars: GHLCalendar[];
  tags: GHLTag[];
  customFields: GHLCustomField[];
  loading: boolean;
}

export function useGHLData(): GHLData {
  const [pipelines, setPipelines] = useState<GHLPipeline[]>([]);
  const [calendars, setCalendars] = useState<GHLCalendar[]>([]);
  const [tags, setTags] = useState<GHLTag[]>([]);
  const [customFields, setCustomFields] = useState<GHLCustomField[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchAll() {
      try {
        const [pipelinesRes, calendarsRes, tagsRes, fieldsRes] = await Promise.allSettled([
          fetch("/api/ghl/pipelines").then((r) => r.json()),
          fetch("/api/ghl/calendars").then((r) => r.json()),
          fetch("/api/ghl/tags").then((r) => r.json()),
          fetch("/api/ghl/custom-fields").then((r) => r.json()),
        ]);

        if (pipelinesRes.status === "fulfilled") {
          setPipelines(pipelinesRes.value.pipelines || []);
        }
        if (calendarsRes.status === "fulfilled") {
          setCalendars(calendarsRes.value.calendars || []);
        }
        if (tagsRes.status === "fulfilled") {
          setTags(tagsRes.value.tags || []);
        }
        if (fieldsRes.status === "fulfilled") {
          setCustomFields(fieldsRes.value.customFields || []);
        }
      } catch (error) {
        console.error("Erro ao buscar dados do GHL:", error);
      } finally {
        setLoading(false);
      }
    }

    fetchAll();
  }, []);

  return { pipelines, calendars, tags, customFields, loading };
}
