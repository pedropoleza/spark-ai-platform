# Guia das IAs da Bianca — como regerar o PDF

O guia é HTML + CSS impresso pelo Chrome headless (a 1ª versão era desenhada à
mão com pdf-lib e ficava pobre: sem tipografia real, sem cantos arredondados,
sem sombra). Editar `guia.html` e rodar:

```
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless --disable-gpu --no-pdf-header-footer \
  --print-to-pdf="_planning/bianca-agentes-2026-08/GUIA-IAs-Bianca-Sofia.pdf" \
  "scripts/guia-bianca/guia.html"
```

⚠️ **Confira renderizando as páginas antes de entregar** — o layout é de altura
FIXA (`.pagina { height: 297mm; overflow: hidden }`), então texto a mais some
sem aviso em vez de quebrar página. Foi o que aconteceu com a pág. 3 na 1ª
tentativa:

```
pdftoppm -png -r 68 _planning/bianca-agentes-2026-08/GUIA-IAs-Bianca-Sofia.pdf /tmp/g
```

⚠️ **Nome de tag é identificador, não texto** — `ia-ligada`, `ia-desligada`,
`novo seguidor`, `origem-anuncio-ia`, `origem-seguidor-ia`,
`agendado-anuncio-ia`, `agendado-seguidor-ia`. Numa passada de revisão de
acentos, `origem-anuncio-ia` virou `origem-anúncio-ia` e o guia passou a mandar
a Sofia usar uma etiqueta que não existe. Se mexer no texto, confira as tags.
