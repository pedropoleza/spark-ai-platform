import { extractMediaAttachments } from "@/lib/ai/media-extractor";

const cases = [
  {
    name: "Stevo CSV: URL sem ext + fileName .csv (caso Pedro)",
    body: { attachments: [{ url: "https://evolution.api/message/media/abc123-uuid", fileName: "Untitled spreadsheet - Sheet1 (2).csv" }] },
    expect: true,
  },
  {
    name: "mediaUrl + fileName top-level .xlsx",
    body: { mediaUrl: "https://stevo.chat/media/xyz789", fileName: "mentoria.xlsx" },
    expect: true,
  },
  {
    name: "attachments mime correto",
    body: { attachments: [{ url: "https://x/f", contentType: "text/csv", fileName: "a.csv" }] },
    expect: true,
  },
  {
    name: "URL com .csv (caso antigo)",
    body: { attachments: [{ url: "https://x/file.csv" }] },
    expect: true,
  },
  {
    name: "Áudio NÃO deve virar attachment doc",
    body: { attachments: [{ url: "https://x/audio", fileName: "voz.ogg", contentType: "audio/ogg" }] },
    expect: false,
  },
];

let pass = 0;
for (const c of cases) {
  const r = extractMediaAttachments(c.body as Record<string, unknown>);
  const ok = (r.length > 0) === c.expect;
  console.log(`${ok ? "✅" : "❌"} ${c.name} → ${r.length} attach ${r.length > 0 ? JSON.stringify(r[0]) : ""}`);
  if (ok) pass++;
}
console.log(`\n${pass}/${cases.length} PASS`);
process.exit(pass === cases.length ? 0 : 1);
