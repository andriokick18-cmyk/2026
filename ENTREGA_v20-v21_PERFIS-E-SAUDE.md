# 📦 ENTREGA v20–v25 — O pacote completo (21/07/2026)

> **Para Andrio e Diego.** Leitura de 4 minutos, celular-friendly.
> Branch: `claude/profile-curriculum-system-twmzop` · 22 commits · `npm test` 19/19 ✅ · CI do GitHub ✅ em todos

---

## 🔥 Começou com o caso real (WhatsApp)

Cliente criou perfil H-2B com carta **"Nenhuma"** e o sistema mandou a carta
do H-2A em TODAS as candidaturas — com o PDF triplicado na conta. Corrigido
nos 4 pontos onde vazava + dedup no upload. **"Nenhuma" agora é Nenhuma.**

## 🩹 Cura automática no 1º boot (nenhuma ação manual)

- PDFs duplicados removidos e perfis reapontados
- Perfis apontando pra PDF inexistente religados pelo nome (ou limpos)
- PDFs em base64 **saem do users.json** → disco (RAM e gravações leves — era
  o combustível do 502 por memória do Servidor 2)
- PDFs órfãos varridos · texto enlatado de fábrica intocado removido
- Logs pra conferir: `[cv-dedup]` `[cv-blobs]` `[cv-sweep]` `[texto-enlatado]` `[ai-kb]`

## 📜 ORDEM EXECUTADA: zero preenchimento padrão

Cadastro nasce em branco; ~20 templates prontos removidos; robô nunca
inventa assunto (pula com aviso); **"IA gera" removido** (era template fixo
disfarçado de IA). Texto que usuário editou é dele e ficou intacto.

## 🧠 O robô agora pensa (v23)

- **Refill sozinho**: fila zerou → recarrega com os MESMOS filtros e avisa
  por push. VIP virou 24/7 de verdade.
- **Fila esperta**: empregador menos contatado pelo app vai primeiro (mais
  resposta, menos spam coletivo).
- **Vaga morta é pulada** sem gastar o limite diário.
- **Aviso de visto**: fila H-2A sem perfil H-2A → usuário fica sabendo.
- 📊 **"Qual texto meu funciona melhor?"** na aba Respostas — taxa de
  resposta por assunto. Nenhum concorrente tem.

## 🌿 Planilhas se mantêm sozinhas (v24)

Robô "Planilha Sempre Fresca" a cada 6h: revisita vagas no DOL, atualiza
status/datas/salário (prioridade: preencher datas da JAN2026 → destrava o
filtro de mês). Enriquecimento agora re-roda a cada 12h. Aparece no feed de
bots do admin.

⚠️ **ATENÇÃO**: o bot de COLETA ("Nova Planilha do DOL") está no KB mas o
código dele NÃO existe neste repositório — se perdeu em algum upload. Se
ainda roda em produção, **puxem o server.js de produção antes do deploy**
pra não perdê-lo de vez. Senão, eu reescrevo do KB.

## 🎓 Usuário nunca mais perdido (v22)

- **Tour em slides** (arrasta pro lado): abre 1x sozinho no login, fica em
  ☰ Menu → Tutorial. Ensina perfil → manual → filtros → automático → respostas.
- **Filtros de verdade**: vários estados de uma vez, mês de início da vaga,
  ordenar por maior salário — manual E automático.

## 🤖 IA sempre à mão (v25)

- Botão 🤖 flutuante em toda tela — chat minimizável sem sair do que estava
  fazendo. Expande pra tela cheia.
- Prompt CORRIGIDO (dava preço errado! agora puxa da tabela oficial
  dinamicamente) + regras atuais de perfil e pagamento.
- **11 entradas de conhecimento H-2B/H-2A** pesquisadas em fontes oficiais
  (USCIS/DOL 2026): direitos, custos reais (incluindo o R$5.000 da live de
  vocês), cap 2026, returning worker, consulado, golpes, temporadas.
- **🎓 Treinar o IA Chat** (admin → Configurações): escrevam as experiências
  de vocês e do Eudes — a IA aprende NA HORA, sem deploy.

## 🔒 Segurança e dinheiro (auditados)

- Tokens do Google não vazam mais pro navegador do admin (2 rotas)
- Remover Gmail extra agora REVOGA o token no Google
- Vazamento de RAM do rateMap (desde a V955) corrigido
- Candidatura nunca sai sem currículo (manual ganhou a trava do automático)
- Fluxo de pedidos auditado: blindagens confirmadas + whitelist de status
- Jornada completa do usuário auditada (205 endpoints inventariados)

## 🧪 Qualidade permanente

- **`npm test`**: 19 verificações com servidor real (~15s). Rode antes de todo deploy.
- **CI no GitHub**: todo push testa sozinho (✅/❌ no commit)
- **Guarda anti-função-duplicada** no build

---

## ✅ CHECKLIST DO DEPLOY (nesta ordem)

1. ⚠️ Conferir o bot de coleta em produção (caixa amarela acima)
2. **Render (2 servidores)**: definir `EDITOR_PWD_ANDREW` e `EDITOR_PWD_DIEGO`
   (senhas de fábrica estão públicas!) — `GEMINI_API_KEY` já deve existir
3. Fazer o deploy da branch nos 2 servidores
4. Olhar os logs do 1º boot: linhas `[cv-dedup]`/`[cv-blobs]` = contas sendo curadas
5. Testar em 2 min: login → tour abre → 🤖 flutuante responde → filtros novos
   → admin → Configurações → 🎓 Treinar IA
6. Adicionar as primeiras experiências de vocês no 🎓 (5 min que valem ouro)
