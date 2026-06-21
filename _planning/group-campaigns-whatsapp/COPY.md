# Copy aprovada — Campanhas em Grupos (Pedro auto-aprovou 2026-06-18)

Fonte da verdade da copy user-facing da feature. Tudo aqui usa **"Spark Leads"/"SparkBot"**, nunca "GHL/GoHighLevel" (regra inviolável). Português BR, tom do SparkBot (próximo, direto, com emoji pontual).

---

## 1. Termos & Segurança — PARTE 2 (consentimento de campanha em grupo)

> Disparado UMA vez por rep, ANTES da primeira campanha de grupo. Aceite persiste em
> `rep_identities.group_campaign_terms_accepted_at`. Reusa o mecanismo de
> `parseTermsResponse` + `buildTermsInteractive` (botões Aceito / Não aceito).

**Mensagem (texto do interactive):**

```
📣 *Campanhas em grupos — antes de começar*

Postar em grupos de WhatsApp é poderoso, mas vem com responsabilidade. Preciso do
seu ok em 3 pontos pra liberar essa função pra você:

1️⃣ *Risco de bloqueio do número.* Enviar muita mensagem, repetida ou pra muita gente
de uma vez, faz o WhatsApp marcar o número como spam — e ele pode ser *bloqueado*.
Eu trabalho pra reduzir isso (espaço os envios, varia o texto, alterna entre grupos),
mas o risco nunca é zero. O número é seu; a decisão de disparar é sua.

2️⃣ *Você é responsável pelo conteúdo.* Nada de promessa de retorno garantido, esquema
de renda, corrente ou spam. Mensagem honesta e relevante pro grupo. Eu te aviso se um
texto parecer arriscado, mas a palavra final — e a responsabilidade — é sua.

3️⃣ *Servidor dedicado recomendado.* Pra proteger seu número, o ideal é rodar campanha
de grupo num *número/servidor dedicado* (separado do seu WhatsApp pessoal). A gente tem
um parceiro de proxy doméstico que oferece esse servidor dedicado — ajuda bastante a
evitar bloqueio. Se quiser, eu falo com o suporte pra te montar um. 💪

Topa seguir com essas condições?
```

**Botões:** `✅ Aceito e quero usar` / `❌ Agora não`

**Aceite →** grava `group_campaign_terms_accepted_at`, responde:
```
Fechou! ✅ Campanhas em grupos liberadas pra você. Quando quiser, é só me dizer o
grupo e a mensagem que eu cuido do resto.
```

**Recusa →** grava `group_campaign_terms_rejected_at`, responde:
```
Sem problema! 👍 Sigo te ajudando com tudo o mais normalmente. Se mudar de ideia sobre
campanhas em grupo, é só falar comigo.
```

---

## 2. Tutorial "enable group view" (SparkBot entrega quando o rep não vê os grupos)

> Helper que o bot manda quando o rep quer fazer campanha de grupo mas os grupos ainda
> não sincronizaram. Habilitar isso no painel sincroniza os grupos do número.

```
Pra eu enxergar e usar seus grupos, primeiro habilita a visualização de grupos no
Spark Leads — leva 20 segundos:

1. No menu da *esquerda*, abre *WhatsApp*.
2. Vai em *Settings* (Configurações).
3. Na primeira aba, *General*, ativa a opção *"Enable group view"*.

Pronto — ele sincroniza seus grupos automaticamente. Me avisa quando ativar que eu
já listo eles pra você. 📋
```

---

## 3. Nudge do servidor dedicado (advisor surfacing quando rep está na número compartilhada)

> Quando `getStevoInstanceForRep` detecta que o rep NÃO tem instância dedicada, a tool
> recusa o disparo e o bot responde com isto (não é só erro seco — é caminho pra resolver).

```
Pra fazer campanha em grupo com segurança, você precisa de um *número dedicado* — separado
do seu WhatsApp do dia a dia. Isso protege seu número principal de bloqueio.

A gente trabalha com um parceiro de proxy doméstico que monta esse servidor dedicado
pra você (a partir de ~$5). Quer que eu abra um pedido pro suporte preparar o seu? 🚀
```

> O SparkBot NÃO provisiona sozinho (decisão Pedro: provisionamento manual da agência).
> Se o rep topar, o bot registra um sinal/pedido pro time (admin_signals / ticket), não
> executa nada externo.

---

## 4. Lista de claims que o advisor de spam sinaliza (`scoreSpamRisk`)

> Regex determinístico em código (NÃO LLM-call). Só *sugere reescrita* (warning).
> Bloqueio duro só em score extremo. Categorias e gatilhos:

| Categoria | Gatilhos (case-insensitive, sem acento) | Peso |
|-----------|------------------------------------------|------|
| Promessa de retorno garantido | `rende \d+%`, `retorno garantido`, `lucro garantido`, `ganho garantido`, `\d+% (ao|por) (mes|ano|dia)`, `retira a qualquer momento`, `sem risco`, `risco zero` | alto |
| Urgência/escassez agressiva | `ultim[ao]s? vagas?`, `so hoje`, `agora ou nunca`, `corre`, `ultima chance`, `vaga limitada` | médio |
| Renda fácil / esquema | `renda extra garantida`, `dinheiro facil`, `fique rico`, `trabalhe de casa e ganhe`, `ganhe ate R?\$`, `multiplique seu dinheiro` | alto |
| Spam clássico | `clique (aqui|no link)`, `>2 links`, `WhatsApp (\+?\d{8,})`, `chama no zap`, texto repetido idêntico | médio |
| CAPS / pontuação gritada | `>40% do texto em CAPS`, `!!!+`, `🔥🔥🔥+` runs de emoji | baixo |

**Resposta do advisor (warning, score médio/alto):**
```
⚠️ Esse texto tem alguns gatilhos que o WhatsApp costuma marcar como spam
(ex.: "{trecho}"). Isso aumenta o risco de bloquear seu número. Sugiro suavizar antes
de disparar. Quer que eu reescreva numa versão mais segura?
```

**Bloqueio duro (score extremo — promessa financeira garantida + urgência + link):**
```
🚫 Não consigo agendar esse texto como está: ele combina promessa de retorno garantido
com urgência e link, que é exatamente o padrão que derruba números. Reescreve sem a
promessa de ganho garantido e a gente segue.
```

---

## 5. Strings de erro da tool (user-facing)

- **Sem instância dedicada** → usa copy nº 3 (nudge servidor dedicado).
- **Grupo announce + rep não-admin** (detectado no preview):
  ```
  O grupo "{nome}" só deixa *admins* postarem, e você não é admin nele. Posso listar os
  grupos onde você consegue postar, se quiser. 🙌
  ```
- **Termos Parte 2 não aceitos** → dispara o fluxo de aceite (copy nº 1) antes de qualquer disparo.
- **Grupos não sincronizados / lista vazia** → usa copy nº 2 (tutorial enable group view).
