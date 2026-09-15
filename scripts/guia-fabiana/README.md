# Guia da IA da Fabiana — como regerar o PDF

HTML + CSS impresso pelo Chrome headless (mesmo padrão do `guia-bianca`).
Editar `guia.html` e rodar:

```
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless --disable-gpu --no-pdf-header-footer \
  --print-to-pdf="_planning/fabiana-campos/GUIA-IA-Fabiana.pdf" \
  "scripts/guia-fabiana/guia.html"
```

⚠️ **Confira renderizando antes de entregar** — a página tem altura FIXA
(`.pagina { height: 297mm; overflow: hidden }`), então texto a mais some sem
aviso em vez de quebrar página:

```
pdftoppm -png -r 68 _planning/fabiana-campos/GUIA-IA-Fabiana.pdf /tmp/gf
```

⚠️ **Os nomes dos campos são os rótulos REAIS da UI** — "Nome do agente",
"Sobre a agência e como agir", Cat "Identidade", Cat "Automações", aba
"Pausadas". Se a UI mudar o rótulo, o guia manda a Fabiana procurar campo que
não existe. Conferir em `src/app/hub/agents/[agentId]/agent-detail-view.tsx`.

⚠️ **A etiqueta `nao-atendemos-living-trust` é identificador, não texto.** Não
acentuar nem trocar por "não-atendemos…" numa revisão de acentos — é a mesma
armadilha que o guia da Bianca documenta.
