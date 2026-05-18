"use client";

import { useState, useMemo } from "react";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface Rep {
  id: string;
  phone: string;
  name: string | null;
  active_location_id: string;
  is_internal: boolean;
  role?: string | null;
  last_inbound_at: string | null;
  created_at: string;
  location_name: string | null;
  location_timezone: string | null;
}

interface RepsData {
  reps: Rep[];
}

export function RepsTab({ data, loading }: { data: RepsData | undefined; loading: boolean }) {
  const [search, setSearch] = useState("");
  const [activity, setActivity] = useState("all");
  const [internalFilter, setInternalFilter] = useState("all");

  const filtered = useMemo(() => {
    if (!data) return [];
    const now = Date.now();
    return data.reps.filter((r) => {
      // Search
      const q = search.toLowerCase().trim();
      if (q) {
        const hay = `${r.phone} ${r.name || ""} ${r.location_name || ""} ${r.active_location_id}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      // Activity
      if (activity !== "all") {
        const last = r.last_inbound_at ? new Date(r.last_inbound_at).getTime() : 0;
        const ageDays = (now - last) / (24 * 3600 * 1000);
        if (activity === "today" && ageDays > 1) return false;
        if (activity === "week" && ageDays > 7) return false;
        if (activity === "month" && ageDays > 30) return false;
        if (activity === "inactive" && ageDays <= 30) return false;
      }
      // Internal
      if (internalFilter === "internal" && !r.is_internal) return false;
      if (internalFilter === "external" && r.is_internal) return false;
      return true;
    });
  }, [data, search, activity, internalFilter]);

  if (loading && !data) return <Skeleton className="h-96" />;
  if (!data) return <div className="text-muted-foreground">Sem dados</div>;

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <div className="flex gap-2 flex-wrap">
          <Input
            placeholder="Buscar por phone / nome / location"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="max-w-xs"
          />
          <Select value={activity} onValueChange={setActivity}>
            <SelectTrigger className="max-w-[180px]">
              <SelectValue placeholder="Atividade" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Toda atividade</SelectItem>
              <SelectItem value="today">Ativo hoje</SelectItem>
              <SelectItem value="week">Ativo 7d</SelectItem>
              <SelectItem value="month">Ativo 30d</SelectItem>
              <SelectItem value="inactive">Inativo &gt;30d</SelectItem>
            </SelectContent>
          </Select>
          <Select value={internalFilter} onValueChange={setInternalFilter}>
            <SelectTrigger className="max-w-[140px]">
              <SelectValue placeholder="Tipo" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos</SelectItem>
              <SelectItem value="external">Externos</SelectItem>
              <SelectItem value="internal">Internos</SelectItem>
            </SelectContent>
          </Select>
          <div className="ml-auto text-sm text-muted-foreground self-center">
            {filtered.length} / {data.reps.length}
          </div>
        </div>
      </Card>

      <Card className="p-0 overflow-hidden">
        <div className="grid grid-cols-12 gap-2 text-xs uppercase text-muted-foreground border-b p-3 bg-muted/50">
          <div className="col-span-3">Phone / Nome</div>
          <div className="col-span-4">Location</div>
          <div className="col-span-2">Último uso</div>
          <div className="col-span-2">Status</div>
          <div className="col-span-1">Created</div>
        </div>
        <div className="divide-y max-h-[600px] overflow-y-auto">
          {filtered.map((r) => (
            <div key={r.id} className="grid grid-cols-12 gap-2 text-xs p-3 hover:bg-muted/30 items-center">
              <div className="col-span-3">
                <div className="font-mono">{r.phone}</div>
                {r.name && <div className="text-muted-foreground">{r.name}</div>}
              </div>
              <div className="col-span-4">
                <div className="truncate">{r.location_name || "(sem nome)"}</div>
                <div className="font-mono text-[10px] text-muted-foreground truncate">
                  {r.active_location_id}
                </div>
              </div>
              <div className="col-span-2 text-muted-foreground">
                {fmtRelative(r.last_inbound_at)}
              </div>
              <div className="col-span-2 flex gap-1 flex-wrap">
                {r.is_internal && <Badge variant="secondary">internal</Badge>}
                {r.role && (
                  <Badge variant="secondary" className="text-[10px]">
                    {r.role}
                  </Badge>
                )}
              </div>
              <div className="col-span-1 text-muted-foreground">
                {new Date(r.created_at).toLocaleDateString("pt-BR", {
                  day: "2-digit",
                  month: "2-digit",
                })}
              </div>
            </div>
          ))}
          {filtered.length === 0 && (
            <div className="p-6 text-center text-muted-foreground text-sm">Sem reps</div>
          )}
        </div>
      </Card>
    </div>
  );
}

function fmtRelative(iso: string | null): string {
  if (!iso) return "nunca";
  const ageSec = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (ageSec < 3600) return `${Math.floor(ageSec / 60)}min ago`;
  if (ageSec < 86400) return `${Math.floor(ageSec / 3600)}h ago`;
  if (ageSec < 86400 * 30) return `${Math.floor(ageSec / 86400)}d ago`;
  return new Date(iso).toLocaleDateString("pt-BR");
}
