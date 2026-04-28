# Brazillionaires Portal — Status do Crawl

**Data:** 2026-04-28
**Estado:** Parcialmente completo. Bloqueado por quota OpenAI (rate limit + budget).

---

## ✅ Completo

### Crawl + extração textual
- 123 items extraídos via API REST pública (`api.ww-api.com/front/get_items/`)
- 32 PDFs baixados + texto extraído via `pdftotext`
- Sections processadas: Eventos/Comece Aqui, Aprender Profissão, Aprender Aplicação
- Bootcamps **NÃO** processado (decisão Pedro: skip)
- Output: `raw/{section}/items/*.json + *.md`, `raw/{section}/pdfs/*.pdf + *.txt`

### Transcrição (parcial)
- **27 vídeos transcritos** com sucesso via OpenAI Whisper API
- Custo: ~$2.27 USD
- Output: `raw/{section}/transcripts/{itemId}-{vimeoId}.{json,md}`

### Processor + chunks
- **84 chunks finais gerados** combinando items + PDFs + transcripts
- Compression média: 42% (raw 473KB → 201KB final)
- 29 items resumidos via Claude Haiku 4.5 (overflow >4500 chars)
- 38 items skipped (estavam vazios — são items sem texto E sem transcript ainda)
- Output: `_planning/carriers/brazillionaires_portal/{section}/*.md`

### Ingestão (parcial)
- **19 chunks inseridos** na `carrier_knowledge` (carrier='brazillionaires_portal')
- 65 chunks falharam embedding por quota OpenAI 429

---

## ❌ Bloqueado

### Quota OpenAI esgotada

Erro 429 começou em:
1. Whisper transcription após ~$2.27 (vídeo 31/68)
2. Embeddings (text-embedding-3-small) após 19 chunks

**Pra desbloquear:** adicionar crédito ou aguardar reset em https://platform.openai.com/usage

### Trabalho pendente quando quota voltar

1. **Re-rodar transcrição dos 41 vídeos restantes** (tentando bitrate 24K pra evitar limite 25MB Whisper):
   ```bash
   # Editar scripts/transcribe-brazillionaires.ts: -b:a 24k em vez de 64k
   npx tsx scripts/transcribe-brazillionaires.ts --workers=4
   ```

2. **2 vídeos sem hash Vimeo** (`420808221`, `449701711`): precisam Chrome MCP pra capturar hash dinâmico do iframe pós-JS:
   - Item 46355812 - "Agendar a Prova" (vimeo 420808221, hash sabido = `f46ad16ffa`)
   - Item 49785317 - "Cálculo do Benefício em Vida" (vimeo 449701711, hash desconhecido)

3. **1 vídeo > 25MB** (`980900211`, "Gravação Academia de Produto"): re-download com bitrate 24K → áudio cabe no limite.

4. **Re-rodar processor** após transcrição completa — vai pegar os 38 items skipped.

5. **Re-ingest com `--force-embed`** — re-embeda os 19 já inseridos (com texto possivelmente atualizado por novos transcripts) + adiciona os 65 que falharam.

6. **Synthetic tests Brazillionaires** pra validar Sparkbot escolhe carrier correto:
   - "como funciona a comissão das anuidades?" → Brazillionaires (Dicas Rita) OU NLG (commission/annuity-general-terms)?
   - "como faço o fingerprint pra licença?" → Brazillionaires (eventos)
   - "como funciona o emergency contact list?" → Brazillionaires
   - "FlexLife pode vender em NY?" → NLG (carrier rules)

---

## Arquivos críticos

```
scripts/
  ├── crawl-brazillionaires.ts        ✅ funciona (idempotente)
  ├── transcribe-brazillionaires.ts   ⚠️ precisa --workers e quota
  ├── process-brazillionaires-chunks.ts ✅ funciona (idempotente)
  └── ingest-carrier-kb.ts            ✅ funciona com --carrier=brazillionaires_portal

_planning/carriers/brazillionaires_portal/
  ├── raw/                            (ignorado pelo ingest)
  │   ├── _video-queue.json           (69 entries)
  │   ├── _pdfs-manifest.json         (32 entries)
  │   ├── eventos/{items,pdfs,transcripts}/
  │   ├── aprender-profissao/{items,pdfs,transcripts}/
  │   └── aprender-aplicacao/{items,pdfs,transcripts}/
  ├── eventos/*.md                    ← chunks (ingestable)
  ├── aprender-profissao/*.md         ← chunks
  ├── aprender-aplicacao/*.md         ← chunks
  └── STATUS.md                       (este arquivo)
```

---

## Comandos úteis pós-quota

```bash
# 1. Continuar transcrição (skip já existentes via dedup do script)
npx tsx scripts/transcribe-brazillionaires.ts --workers=4

# 2. Re-processar (idempotente, atualiza chunks com transcripts novos)
npx tsx scripts/process-brazillionaires-chunks.ts

# 3. Ingest tudo (skip metadata-only se hash igual)
npx tsx scripts/ingest-carrier-kb.ts --carrier=brazillionaires_portal

# 4. Verificar status
curl -H "Cookie: <admin>" https://spark-ai-platform.vercel.app/api/admin/carrier-kb?carrier=brazillionaires_portal | jq .metrics

# 5. Synthetic test
curl -X POST https://spark-ai-platform.vercel.app/api/agents/account-assistant/synthetic-test \
  -H "Authorization: Bearer spark-cron-secret-2026" \
  -H "Content-Type: application/json" \
  -d '{"message":"como funciona o emergency contact list?","rep_phone":"+17867717077","input_kind":"text"}'
```

---

## Estatísticas finais (parciais)

| Métrica | Valor |
|---|---|
| Items extraídos | 123 |
| PDFs baixados | 32 |
| Vídeos transcritos | 27 / 69 (39%) |
| Vídeos pendentes | 42 (41 sem transcript + 1 retry bitrate) |
| Chunks gerados | 84 |
| Chunks ingeridos | 19 / 84 (23%) |
| Pendentes ingest | 65 |
| Custo OpenAI gasto | ~$2.30 (Whisper) + ~$0.001 (embeddings) |
| Custo OpenAI estimado pra completar | ~$13-15 (Whisper restante) + ~$0.005 (embeddings) |
