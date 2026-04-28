# Brazillionaires Portal — Status

**Última atualização:** 2026-04-28 (sessão final)
**Estado:** ✅ Production-ready (135 chunks total: 49 NLG + 86 Brazillionaires)
**Synthetic tests final:** 11/11 PASS

---

## ✅ Concluído

### Crawl + extração textual
- 123 items extraídos via API REST pública (`api.ww-api.com/front/get_items/`)
- 32 PDFs baixados + texto extraído via `pdftotext`
- Sections processadas: Eventos/Comece Aqui, Aprender Profissão, Aprender Aplicação
- Bootcamps NÃO processado (decisão Pedro: skip)

### Transcrição (parcial — 30/68 vídeos)
- 30 vídeos transcritos com sucesso
  - 27 via OpenAI Whisper (~$2.27 USD antes de quota)
  - 3 via Groq whisper-large-v3 (free tier, $0)
- 38 vídeos pendentes (Groq rate limit ASPH 7200s/hora — completar em batches)

### Processor + chunks
- 86 chunks finais gerados combinando items + PDFs + transcripts
- Compression média: 40%
- 32 items resumidos via Claude Haiku 4.5 (overflow >4500 chars)

### Embeddings + Ingest
- 86/86 chunks ingeridos com Voyage AI voyage-3-large (1024 dims)
- Migration 00039: `vector(1536) → vector(1024)`
- Provider migrado de OpenAI text-embedding-3-small → Voyage AI

### Sparkbot integration
- Tool `query_carrier_knowledge` aceita parameter `kb`:
  - `national_life_group` (49 chunks)
  - `agency_brazillionaires` (86 chunks)
- 7 exemplos concretos na tool description guiando LLM
- `category_hint` opcional, só pra NLG; pra agency deixa similarity decidir

### Final synthetic tests (11/11 PASS)
- 3 NLG (FlexLife, diabetes UW, Brazil FN)
- 4 Brazillionaires (Emergency Contact, fingerprint, Napkin Presentations, Dicas Rita)
- 2 cross-KB (UW diabetes, NY Reg 187 — chama tool 2x)
- 2 adversarial (recusa DL12 invent, fora de escopo unrelated)

---

## ⏳ Pendente

### Vídeos restantes (38 / 68)

Causa: Groq Whisper free tier ASPH 7200s/hora. Reset a cada hora.

Pra retomar:
```bash
# Cada hora o rate limit reseta — rodar bate em ~2h de áudio
npx tsx scripts/transcribe-brazillionaires.ts --workers=2
# Quando completar (vai dar erros 429 e parar)
# Aguardar 1h
# Re-rodar (skipping inteligente pega só os pendentes)
```

Total estimado pra completar: ~12-14h wall time (38 vídeos × 38 min ÷ 7200s/hora).

Falhas conhecidas que NÃO vão resolver mesmo após quota:
- 2 vídeos sem hash Vimeo (`420808221`, `449701711`) — yt-dlp 401 Unauthorized
- 1 vídeo `980900211` com áudio >25MB mesmo em 24K bitrate

Quando todos transcripts estiverem prontos:
```bash
npx tsx scripts/process-brazillionaires-chunks.ts
npx tsx scripts/ingest-carrier-kb.ts --carrier=agency_brazillionaires
```

---

## 📊 Estatísticas finais

| Métrica | NLG | Brazillionaires | Total |
|---|---|---|---|
| Chunks no DB | 49 | 86 | 135 |
| Embedding model | voyage-3-large | voyage-3-large | — |
| Embedding dim | 1024 | 1024 | — |
| Volume conteúdo | ~95KB | ~214KB | ~309KB |
| Synthetic tests | 3/3 | 4/4 | 7/7 funcional |
| Adversarial gates | — | — | 2/2 |
| Cross-KB tests | — | — | 2/2 |
| **TOTAL** | — | — | **11/11 PASS** |

---

## Custo investido

| Provider | Valor | Notas |
|---|---|---|
| OpenAI Whisper | $2.27 | 27 transcripts antes da quota |
| Groq Whisper | $0.00 | 3 transcripts via free tier |
| Voyage embeddings | $0.00 | 135 chunks dentro do free tier 200M tokens |
| Anthropic Claude Haiku | <$0.05 | 32 summaries de items grandes |
| **TOTAL** | **~$2.30** | — |

---

## Comandos úteis

```bash
# Continuar transcrição
npx tsx scripts/transcribe-brazillionaires.ts --workers=2

# Re-processar
npx tsx scripts/process-brazillionaires-chunks.ts

# Ingest
npx tsx scripts/ingest-carrier-kb.ts --carrier=agency_brazillionaires

# Verificar via admin
curl -H "Cookie: <admin>" https://spark-ai-platform.vercel.app/api/admin/carrier-kb?carrier=agency_brazillionaires | jq .metrics

# Synthetic test
curl -X POST https://spark-ai-platform.vercel.app/api/agents/account-assistant/synthetic-test \
  -H "Authorization: Bearer spark-cron-secret-2026" \
  -H "Content-Type: application/json" \
  -d '{"message":"como funciona o emergency contact list?","rep_phone":"+17867717077","input_kind":"text"}'
```
