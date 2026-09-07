# H2BApply — Camada Extras v1.0 (Melhorias + Novas Funcionalidades)

Dois módulos autocontidos foram adicionados, **sem alterar nenhuma linha do código existente** (zero risco de quebrar o app):

- `h2b-extras-user.js` → injetado no `index.html` (todas as abas do usuário)
- `h2b-extras-admin.js` → injetado no `admin.html` (todas as views do admin)
- `sw.js` → versão do cache atualizada de `v6` para `v7` (garante que os usuários com PWA instalado recebam a atualização)

Tudo é client-side (DOM + localStorage), então funciona em **todas as abas simultaneamente**: Manual, Currículos, Automático, Respostas, Histórico, Salvos, Ranking, Planos, Pesquisa, Notificações, Configurações, Indicar — e no admin: Dashboard, Usuários, Pedidos, Pagantes, VIP, Planilhas, Ranking, Incidentes, Sugestões, Notificações, Códigos, Robô Contábil, Logs etc.

---

## 👤 USUÁRIO (index.html)

### 10 Melhorias (aplicam-se a todas as abas)
1. **Indicador offline/online** — barra vermelha no topo quando cai a conexão + toast ao voltar.
2. **ESC fecha modais** — qualquer overlay/modal aberto fecha com a tecla Escape.
3. **Botão "voltar ao topo"** — aparece automaticamente ao rolar mais de 600px.
4. **Autosave de rascunhos** — tudo que você digita em campos de texto grandes é salvo e restaurado se o app fechar.
5. **Atalhos de teclado** — `1-5` troca de aba, `/` foca a busca, `T` alterna tema, `X` abre Extras.
6. **Duplo clique limpa a busca** — em qualquer campo de busca/filtro.
7. **Memória da última aba** — o app lembra qual aba você estava usando.
8. **Segurança em links externos** — `rel="noopener noreferrer"` aplicado automaticamente (proteção contra tabnabbing).
9. **Fonte ajustável e persistente** — tamanho de letra escolhido fica salvo entre sessões.
10. **Estatísticas de uso** — o app passa a registrar sessões, tempo de uso e aba favorita (dados 100% locais).

### 11 Novas Funcionalidades (botão ✨ flutuante, disponível em todas as abas)
1. **📝 Bloco de Notas** — anotações persistentes (contatos de empresas, senhas de portais...) com botão copiar.
2. **⏰ Lembretes de Follow-up** — crie lembretes com data ("reenviar e-mail para Ocean Resort"); badge vermelho no botão ✨ e aviso ao abrir o app quando vencer.
3. **🇺🇸 Horário nos EUA** — relógio ao vivo dos 4 fusos (NY, Chicago, Denver, LA) com indicador 🟢/🔴 da melhor janela para contatar empregadores (9h–17h local).
4. **💵 Calculadora de Salário** — USD/hora → semana, mês e hora extra (1.5x) já convertidos para R$; cotação fica salva.
5. **📊 Minhas Estatísticas** — sessões, horas de uso, aba mais usada, lembretes ativos.
6. **💾 Backup/Restauração** — baixa um .json com todos os dados locais e restaura em outro aparelho.
7. **🌙 Alternador de tema** — claro/escuro em 1 toque, com persistência.
8. **🎯 Modo Foco** — esconde banners e rodapé para trabalhar sem distração.
9. **📲 Compartilhar App** — share nativo do celular ou WhatsApp direto.
10. **🔡/🔠 Controle de fonte A−/A+** — acessibilidade (85% a 130%).
11. **🔔 Alerta de follow-ups pendentes** — ao abrir o app, avisa quantos lembretes venceram.

---

## 🛠️ ADMIN (admin.html)

### 10 Melhorias (aplicam-se a todas as views)
1. **Ordenação por clique** — clique em qualquer cabeçalho de tabela para ordenar (número ou texto, asc/desc).
2. **Duplo clique copia célula** — copie e-mail, UID, valor etc. de qualquer tabela instantaneamente.
3. **ESC fecha modais** — qualquer modal do painel.
4. **Atalhos** — `/` abre o filtro de tabela, `R` recarrega a view atual.
5. **Indicador offline** — a barra de ferramentas fica vermelha sem conexão.
6. **Realce de linha no hover** — leitura mais fácil de tabelas longas.
7. **Links externos seguros** — `rel="noopener"` automático.
8. **Relógio + tempo de sessão** — sempre visível no canto superior.
9. **Contador de linhas filtradas** — "23 / 148 linhas" ao usar o filtro.
10. **Aviso de tarefas pendentes** — ao abrir o painel, alerta quantas tarefas admin estão abertas.

### 10 Novas Ferramentas (barra fixa no topo direito + painel ⚙️)
1. **🔍 Filtro instantâneo universal** — filtra as linhas de QUALQUER tabela visível (usuários, pedidos, pagantes, incidentes...).
2. **CSV** — exporta a tabela visível para CSV (Excel, com BOM UTF-8 e `;`).
3. **JSON** — exporta a tabela visível para JSON estruturado.
4. **🖨️ Impressão limpa** — imprime a view atual sem as barras de ferramentas.
5. **⟳ Auto-refresh** — recarrega a view ativa a cada 60s (liga/desliga).
6. **📏 Modo compacto** — aumenta a densidade das tabelas (mais linhas na tela), persistente.
7. **🦓 Zebra striping** — listras alternadas nas tabelas, persistente.
8. **💾 Backup do painel** — exporta todo o localStorage do admin em .json.
9. **🧹 Limpar filtros** — restaura todas as linhas ocultas de uma vez.
10. **📝 Notas + ✅ Tarefas do Admin** — bloco de notas auto-salvo e lista de tarefas com checkbox, persistentes.

---

## Como testar
1. Suba os arquivos como sempre (nenhuma dependência nova; os dois .js são estáticos).
2. Usuário: abra o app → botão roxo **✨** no canto inferior direito.
3. Admin: barra de ferramentas fixa no canto superior direito → **⚙️** para o painel completo.
4. PWA: o bump para `h2bapply-v7` no `sw.js` força a atualização do cache nos aparelhos.

## Garantias
- Nenhuma função existente foi modificada (apenas 1 linha de `<script>` adicionada em cada HTML + bump de versão no sw.js).
- Sintaxe validada com Node (`node --check`) nos dois módulos e no sw.js.
- Se quiser desativar tudo, basta remover a linha do `<script src="h2b-extras-...">` do HTML correspondente.
