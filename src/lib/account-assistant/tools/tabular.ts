/**
 * Tools tabulares: importar contatos de CSV/XLSX + analisar dados.
 *
 * Acessa os rows via ctx.attachment (passado pelo processor quando a turn
 * tem um RepInput.kind='tabular'). Bot NÃO precisa copiar rows como
 * string em args — economiza tokens e evita perda de dados em planilhas
 * grandes.
 *
 * Tool design:
 *   - analyze_tabular_data (safe): bot vê stats, sem mexer no CRM.
 *   - import_contacts_from_data (high): cria contatos no GHL — pede
 *     confirmação enforced pelo gate H8.
 *
 * Limites:
 *   - max 500 contatos por chamada (já truncado no parser)
 *   - GHL: bulk via /contacts/upsert em batch paralelo controlado
 */

import type { ToolEntry } from "./types";
import { getRepGhlUserId } from "./types";
import { upsertContact, postNoteOnContactRaw } from "@/lib/ghl/operations";
import { normalizePhone, resolveLocationDefaultCountry } from "../identity";
import type { RepInput } from "@/types/account-assistant";

const IMPORT_BATCH_SIZE = 10; // chamadas GHL paralelas por batch
const IMPORT_MAX_TOTAL = 500;
const DEFAULT_AUTO_TAG = "imported-via-sparkbot";

interface ColumnMapping {
  first_name?: string;
  last_name?: string;
  full_name?: string;     // se existir só uma coluna "Nome", parte em first/last
  phone?: string;
  email?: string;
  city?: string;
  state?: string;
  source?: string;        // coluna que vai pra "source" do GHL
  notes?: string;         // coluna que vai pra notes
}

const analyzeTabularData: ToolEntry = {
  def: {
    name: "analyze_tabular_data",
    description:
      "Analisa dados tabulares (CSV/XLSX) anexados à turn ATUAL. Use quando rep anexar planilha e perguntar 'o que tem aí', 'quantas linhas', 'quais colunas têm phone'. Retorna stats sem mexer no CRM. NÃO use se rep pedir IMPORT — pra isso use import_contacts_from_data.",
    risk: "safe",
    parameters: {
      type: "object",
      properties: {
        sample_size: {
          type: "number",
          default: 5,
          description: "Quantas linhas de amostra retornar (max 20).",
        },
      },
    },
  },
  handler: async (ctx, args) => {
    const att = ctx.attachment;
    if (!att || att.kind !== "tabular") {
      // H49 (post-mortem Jussara 2026-07-03): explicação HONESTA e completa pro LLM.
      // A msg antiga ("peça pra reanexar") não explicava a mecânica → o LLM inventou
      // um "TTL de 30 minutos" e repetiu como fato 8×, num loop de 12 reanexos.
      return {
        status: "error",
        message:
          "O arquivo da planilha só fica disponível NO TURNO em que o rep o enviou — " +
          "esta mensagem do rep veio SEM anexo, então não tenho mais acesso aos dados. " +
          "ISSO NÃO É EXPIRAÇÃO/TTL — nunca explique como 'o servidor guarda por X minutos'. " +
          "Diga apenas que precisa do arquivo junto da instrução e peça pra reenviar o .xlsx " +
          "JÁ COM tudo decidido no caption (o que importar/disparar), pra resolver em UMA mensagem.",
        retryable: false,
      };
    }
    const t = att.tabular;
    const sampleSize = Math.min(Math.max(Number(args.sample_size) || 5, 1), 20);
    const sample = t.rows.slice(0, sampleSize);

    // Heurística simples: detecta colunas que parecem phone/email
    const phoneLike: string[] = [];
    const emailLike: string[] = [];
    for (const col of t.columns) {
      const sampleVals = sample.map((r) => String(r[col] || "")).filter(Boolean).slice(0, 5);
      if (sampleVals.length === 0) continue;
      if (sampleVals.every((v) => /^[+\d().\-\s]+$/.test(v) && v.replace(/\D/g, "").length >= 8)) {
        phoneLike.push(col);
      }
      if (sampleVals.every((v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v))) {
        emailLike.push(col);
      }
    }

    return {
      status: "ok",
      data: {
        filename: t.filename,
        total_rows: t.total_rows,
        columns: t.columns,
        sheets: t.sheets?.map((s) => ({ name: s.name, total_rows: s.total_rows, columns: s.columns })) || [],
        active_sheet: t.active_sheet,
        sample_rows: sample,
        detected: {
          phone_like_columns: phoneLike,
          email_like_columns: emailLike,
        },
      },
    };
  },
};

const importContactsFromData: ToolEntry = {
  def: {
    name: "import_contacts_from_data",
    description:
      "Importa contatos em massa pro Spark Leads a partir da planilha anexada à turn atual.\n\n" +
      "FLUXO RECOMENDADO:\n" +
      "1. Use analyze_tabular_data primeiro pra ver columns e detectar phone/email.\n" +
      "2. Sugira o column_mapping ao rep ('vou mapear Name→firstName, Phone→phone... confirma?').\n" +
      "3. Após confirmação verbal, chame esta tool com confirmed_by_rep:true.\n\n" +
      "MAPPING: passe o NOME EXATO da coluna do CSV/XLSX em cada slot (case-sensitive). " +
      "Pelo menos uma de phone OU email é OBRIGATÓRIA. Se a planilha tem só 'Nome Completo', " +
      "use full_name (sistema parte em first/last automaticamente).\n\n" +
      "TAGS: tags adicionais aplicadas a TODOS os contatos importados. A tag 'imported-via-sparkbot' " +
      "é adicionada automaticamente pra auditoria.\n\n" +
      "LIMITE: 500 contatos por chamada. Se a planilha tem mais, o rep precisa filtrar antes.",
    risk: "high",
    parameters: {
      type: "object",
      properties: {
        column_mapping: {
          type: "object",
          description: "Mapping coluna CSV/XLSX → campo Spark Leads. Ex: {first_name: 'Nome', phone: 'Telefone'}",
          properties: {
            first_name: { type: "string", description: "Coluna com primeiro nome" },
            last_name: { type: "string", description: "Coluna com sobrenome" },
            full_name: { type: "string", description: "Coluna com nome completo (se não tiver first/last separados)" },
            phone: { type: "string", description: "Coluna com telefone (obrigatório se não tiver email)" },
            email: { type: "string", description: "Coluna com email (obrigatório se não tiver phone)" },
            city: { type: "string", description: "Coluna com cidade (opcional)" },
            state: { type: "string", description: "Coluna com estado (opcional)" },
            source: { type: "string", description: "Coluna com fonte/origem do lead (opcional)" },
            notes: { type: "string", description: "Coluna com observações/notes (opcional)" },
          },
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Tags pra aplicar em TODOS os contatos importados (ex: ['cold-list-jan']).",
        },
        target_location_id: {
          type: "string",
          description: "OPCIONAL. Location pra importar (default: active_location do rep).",
        },
        assigned_to: {
          type: "string",
          description:
            "OPCIONAL. User ID do Spark Leads pro dono de TODOS os contatos importados. " +
            "Se o rep pedir 'me coloca como owner' / 'meu user como owner', use 'self' " +
            "(a tool resolve automaticamente pro ghl_user_id do rep na location ativa). " +
            "Pode também passar o user_id direto se for outro user.",
        },
      },
      required: ["column_mapping"],
    },
  },
  handler: async (ctx, args) => {
    const att = ctx.attachment;
    if (!att || att.kind !== "tabular") {
      // H49 (post-mortem Jussara 2026-07-03): mesma explicação honesta do analyze.
      return {
        status: "error",
        message:
          "O arquivo da planilha só fica disponível NO TURNO em que o rep o enviou — " +
          "esta mensagem veio SEM anexo. ISSO NÃO É EXPIRAÇÃO/TTL — nunca invente mecânica " +
          "interna ('servidor guarda 30 min', 'timer reinicia'). Peça o .xlsx de novo e " +
          "IMPORTE+DISPARE no MESMO turno em que ele chegar, usando as decisões que o rep " +
          "já confirmou nesta conversa (não re-pergunte o que já foi respondido).",
        retryable: false,
      };
    }
    const t = att.tabular;

    if (t.total_rows > IMPORT_MAX_TOTAL) {
      return {
        status: "error",
        message: `Planilha tem ${t.total_rows} linhas, máximo permitido por import é ${IMPORT_MAX_TOTAL}. Peça ao rep pra dividir.`,
        retryable: false,
      };
    }

    const mapping = (args.column_mapping || {}) as ColumnMapping;
    const tags = Array.isArray(args.tags) ? (args.tags as string[]) : [];
    const targetLocation = args.target_location_id ? String(args.target_location_id) : ctx.locationId;

    // FIX CRITICAL stress test 2026-05-03: validar target_location_id está
    // entre as locations do rep. Antes, prompt injection em CSV cell podia
    // forçar LLM a passar location_id de OUTRA agência → contatos importados
    // em tenant errado (CRM hijack).
    if (args.target_location_id) {
      const allowedLocations = ctx.rep.ghl_users.map((u) => u.location_id);
      if (!allowedLocations.includes(targetLocation)) {
        return {
          status: "error",
          message:
            `target_location_id "${targetLocation}" não está entre as locations autorizadas do rep ` +
            `(${allowedLocations.join(", ")}). Por segurança, só importo em locations que o rep tem acesso.`,
          retryable: false,
        };
      }
    }

    // Resolve default country pra normalizePhone via timezone da location.
    // Sem isso, números BR de 10/11 dígitos viram +1 (US wrong). Helper
    // compartilhado com as tools de contato (create/update) — fonte única.
    const defaultCountry = await resolveLocationDefaultCountry(targetLocation);

    // Owner: 'self' resolve pro ghl_user_id do rep na location ativa.
    // Aceita também o user_id direto (caso o rep peça pra atribuir a outro).
    let assignedTo: string | undefined;
    if (args.assigned_to) {
      const raw = String(args.assigned_to).trim();
      if (raw === "self" || raw === "me" || raw === "rep") {
        const repGhlUserId = getRepGhlUserId(ctx);
        if (!repGhlUserId) {
          return {
            status: "error",
            message:
              "Não achei seu user ID na location ativa pra setar como owner. " +
              "Verifique se você tá cadastrado no Spark Leads desta location.",
            retryable: false,
          };
        }
        assignedTo = repGhlUserId;
      } else {
        assignedTo = raw;
      }
    }

    // Validação: ao menos phone OU email mapeado
    if (!mapping.phone && !mapping.email) {
      return {
        status: "error",
        message: "Mapping inválido: precisa mapear pelo menos uma de 'phone' ou 'email'. Verifica nomes EXATOS das colunas.",
        retryable: false,
      };
    }

    // Validação: colunas mapeadas existem na planilha
    const cols = new Set(t.columns);
    const missing: string[] = [];
    for (const [field, col] of Object.entries(mapping)) {
      if (col && !cols.has(col)) missing.push(`${field}:${col}`);
    }
    if (missing.length > 0) {
      return {
        status: "error",
        message: `Colunas não existem na planilha: ${missing.join(", ")}. Colunas disponíveis: ${t.columns.join(", ")}`,
        retryable: false,
      };
    }

    // Constroi lista de contatos
    const allTags = Array.from(new Set([...tags, DEFAULT_AUTO_TAG]));
    const contactsToCreate: Array<{
      idx: number;
      payload: Record<string, unknown>;
      identifier: string;
      notes_text: string; // texto da coluna mapeada como notes (vazio = sem nota)
    }> = [];
    const skipped: Array<{ idx: number; reason: string; row: Record<string, unknown> }> = [];

    t.rows.forEach((row, idx) => {
      // Extrai campos do mapping
      const get = (col?: string) => col ? String(row[col] ?? "").trim() : "";
      let firstName = get(mapping.first_name);
      let lastName = get(mapping.last_name);
      const fullName = get(mapping.full_name);
      const phone = get(mapping.phone);
      const email = get(mapping.email);
      const city = get(mapping.city);
      const state = get(mapping.state);
      const source = get(mapping.source);
      const notes = get(mapping.notes);

      // Parte full_name se first/last não foram passados separados
      if (fullName && !firstName && !lastName) {
        const parts = fullName.split(/\s+/);
        firstName = parts[0];
        lastName = parts.slice(1).join(" ");
      }

      // Pelo menos um identificador (phone OU email)
      const normalizedPhone = phone ? normalizePhone(phone, defaultCountry) : "";
      const validPhone = normalizedPhone && normalizedPhone.replace(/\D/g, "").length >= 10;
      const validEmail = email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

      if (!validPhone && !validEmail) {
        skipped.push({ idx, reason: "phone e email inválidos/ausentes", row });
        return;
      }

      const payload: Record<string, unknown> = {
        locationId: targetLocation,
        firstName: firstName || undefined,
        lastName: lastName || undefined,
        phone: validPhone ? normalizedPhone : undefined,
        email: validEmail ? email.toLowerCase() : undefined,
        city: city || undefined,
        state: state || undefined,
        source: source || "Sparkbot Import",
        tags: allTags,
        assignedTo: assignedTo, // undefined = GHL não muda owner; string = aplica esse user
      };

      contactsToCreate.push({
        idx,
        payload,
        identifier: validPhone ? normalizedPhone : email,
        notes_text: notes,
      });
    });

    if (contactsToCreate.length === 0) {
      return {
        status: "error",
        message: `Nenhum contato válido. ${skipped.length} linhas skipadas (phone/email inválidos).`,
        retryable: false,
      };
    }

    // Importa em batches paralelos
    const created: Array<{
      idx: number;
      ghl_id: string;
      identifier: string;
      notes_text: string;
    }> = [];
    const failed: Array<{ idx: number; identifier: string; reason: string }> = [];

    for (let i = 0; i < contactsToCreate.length; i += IMPORT_BATCH_SIZE) {
      const batch = contactsToCreate.slice(i, i + IMPORT_BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map(async (c) => {
          // GHL V2 /contacts/upsert é idempotente por phone/email — se rep
          // re-importa mesma planilha, não duplica.
          const res = await upsertContact(ctx.ghlClient, c.payload);
          const ghlId = res.contact?.id;
          if (!ghlId) throw new Error("response sem contact.id");
          return { idx: c.idx, ghl_id: ghlId, identifier: c.identifier, notes_text: c.notes_text };
        }),
      );
      results.forEach((r, j) => {
        const c = batch[j];
        if (r.status === "fulfilled") {
          created.push(r.value);
        } else {
          const reason = r.reason instanceof Error ? r.reason.message : String(r.reason);
          failed.push({ idx: c.idx, identifier: c.identifier, reason: reason.slice(0, 200) });
        }
      });
    }

    // Cria notas pra contatos que tinham coluna `notes` mapeada e texto não-vazio.
    // GHL não aceita notes em /contacts/upsert, então é segunda chamada por contato.
    // Roda em paralelo controlado pra não estourar rate limit.
    let notesCreated = 0;
    let notesFailed = 0;
    if (mapping.notes) {
      const repGhlUserId = getRepGhlUserId(ctx);
      const contactsWithNotes = created.filter((c) => c.notes_text && c.notes_text.trim().length > 0);
      for (let i = 0; i < contactsWithNotes.length; i += IMPORT_BATCH_SIZE) {
        const batch = contactsWithNotes.slice(i, i + IMPORT_BATCH_SIZE);
        const noteResults = await Promise.allSettled(
          batch.map((c) =>
            postNoteOnContactRaw(ctx.ghlClient, c.ghl_id, {
              body: c.notes_text,
              userId: repGhlUserId, // se undefined, GHL usa o user do token
            }),
          ),
        );
        for (const r of noteResults) {
          if (r.status === "fulfilled") notesCreated++;
          else notesFailed++;
        }
      }
    }

    return {
      status: "ok",
      data: {
        filename: t.filename,
        target_location_id: targetLocation,
        total_rows: t.total_rows,
        created_count: created.length,
        failed_count: failed.length,
        skipped_count: skipped.length,
        tags_applied: allTags,
        assigned_to: assignedTo || null,
        notes_created: notesCreated,
        notes_failed: notesFailed,
        notes_mapped_column: mapping.notes || null,
        // Trunca samples pra não estourar response (LLM já tem o info essencial)
        created_sample: created.slice(0, 5).map((c) => ({
          idx: c.idx, ghl_id: c.ghl_id, identifier: c.identifier,
          had_note: !!c.notes_text,
        })),
        failed_sample: failed.slice(0, 5),
        skipped_sample: skipped.slice(0, 3).map((s) => ({ idx: s.idx, reason: s.reason })),
      },
    };
  },
};

export const TABULAR_TOOLS: ToolEntry[] = [analyzeTabularData, importContactsFromData];
