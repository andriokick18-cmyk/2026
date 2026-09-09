# H2BApply 🇺🇸✈️ — reconstrução "2026"

Plataforma de candidatura automática para vagas **H-2B e H-2A** nos Estados
Unidos. Este repositório é uma reconstrução enxuta do H2BApply original:
mantém o motor de envio (manual e automático), login com Google e perfis de
currículo, mas **remove** ranking, IA/Gemini (incluindo o antigo Cérebro
Contábil), aba de notícias, chat, e o menu/drawer — trocados por uma
navegação e um onboarding bem mais simples. O pagamento também mudou: não
existe mais moeda intermediária (diamante) — o usuário escolhe plano e
período, paga via Pix e sobe o comprovante diretamente.

## O que faz

- Envia candidaturas automáticas por Gmail para empresas certificadas pelo DOL
- Gerencia perfis de e-mail com rotação de assuntos e corpos (anti-spam)
- Suporta upload de currículo PDF e cover letter (pelo menos um dos dois é
  obrigatório por perfil)
- Exibe vagas das planilhas DOL (Jan/2026, Jul/2025, Jul/2026, H-2A) e
  "Vagas ao Vivo" (busca direta ao DOL)
- Onboarding obrigatório com perfis separados H-2B e H-2A (pelo menos um dos
  dois precisa ser criado antes de usar o app)
- Compra direta de plano (VIP/VIPro/DoublePro): escolhe plano+período, vê o
  preço oficial, paga via Pix e sobe o comprovante. Se o valor bater, o
  plano ativa na hora por 3 dias (janela provisória) enquanto o pedido
  segue pendente — a confirmação humana do admin continua SEMPRE
  obrigatória pro período cheio
- Painel admin (`/admin`) focado em contabilidade: total recebido, gastos por
  sócio, lista de usuários por dias de VIP restantes, aprovação de pedidos
  pendentes

## O que NÃO existe (removido de propósito nesta reconstrução)

Ranking/gamificação, chat com IA, Cérebro Contábil, aba de Notícias, seletor
de idioma (o app é só em português), robôs de coleta automática de planilhas
(as planilhas são estáticas), códigos promocionais, Vagas Salvas, aba
Enviadas (histórico continua existindo internamente pra evitar duplicatas,
só não tem mais uma tela dedicada de navegação), menu/drawer hambúrguer.

## Stack

- **Backend:** Node.js puro (sem frameworks)
- **Frontend:** HTML/CSS/JS vanilla (SPA)
- **Auth:** Google OAuth 2.0 (Gmail)
- **Deploy:** Render.com

## Estrutura

```
├── server.js              # Backend completo (Node.js)
├── index.html             # Frontend do usuário (SPA)
├── admin.html             # Painel admin (contabilidade + pedidos pendentes)
├── sw.js                  # Service Worker (PWA)
├── manifest.json          # PWA manifest
├── package.json           # Dependências
├── .env.example           # Variáveis de ambiente necessárias
├── jan2026_compact.json   # Planilha DOL Janeiro 2026
├── jul2025_compact.json   # Planilha DOL Julho 2025
├── jul2026_compact.json   # Planilha DOL Julho 2026
├── h2a_jun2026_compact.json # Planilha H-2A (agricultura)
├── tutorial-img/          # Fotos do tutorial (onboarding + central de ajuda)
└── icon-*.png             # Ícones PWA
```

## Setup

### 1. Clonar e instalar
```bash
git clone https://github.com/andriokick18-cmyk/2026.git
cd 2026
npm install
```

### 2. Configurar variáveis de ambiente
```bash
cp .env.example .env
# Editar .env com suas credenciais
```

### 3. Variáveis obrigatórias no `.env`
```
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
ADMIN_EMAIL=seu@email.com
APP_URL=https://seu-dominio.com
```
Recomendada em produção: `DATA_ENC_KEY` (cifra os tokens Gmail no disco).
Veja todas em `.env.example`.

### 4. Rodar localmente
```bash
npm start
```

### 5. Verificar antes de commitar
```bash
npm test   # npm run check (sintaxe + função duplicada) + smoke-test.js (~30s, servidor real + fixtures)
```
`smoke-test.js` já foi atualizado pra esta reconstrução e roda no CI a
cada push (`.github/workflows/ci.yml`).

## Deploy no Render

1. Conectar o repositório no [Render.com](https://render.com)
2. **Build Command:** `npm install`
3. **Start Command:** `node server.js`
4. Adicionar todas as variáveis do `.env.example` no painel do Render
5. Criar um **Persistent Disk** em `/data` para salvar dados dos usuários

## Licença

Privado — todos os direitos reservados.
