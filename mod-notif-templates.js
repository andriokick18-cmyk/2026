/* 📨 src/notif-templates.js — Templates de e-mail do Sentinel (Fase 1 · Módulo 3) */
"use strict";

const MSGS_VIP_EXPIRING = [
  { sub:"⏳ {nome}, seu plano VIP do H2BApply expira em poucos dias!", body:`Oi {nome}! 👋

Passando pra te avisar com carinho: seu plano VIP do H2BApply está chegando ao fim (menos de 3 dias restantes).

🇺🇸 Você já chegou até aqui na busca pelo seu trabalho nos EUA — não deixe o robô parar justo agora, na época em que os empregadores mais respondem!

✅ Para renovar é rápido:
1. Acesse h2bapply.com
2. Vá em "Planos"
3. Escolha a renovação — seus dias restantes são somados, você não perde nada!

Qualquer dúvida, é só responder este e-mail. Estamos torcendo por você! 💪

— Equipe H2BApply 🤖` },
  { sub:"🚨 Últimos dias do seu VIP, {nome}! O robô não pode parar", body:`E aí {nome}! 😃

Seu acesso VIP do H2BApply expira em breve (3 dias ou menos). Depois disso o envio automático volta ao limite gratuito.

💡 Renovando AGORA você garante:
• Robô enviando currículos enquanto você dorme 😴
• Prioridade nas vagas novas das planilhas
• Seus dias restantes SOMAM com a renovação

Acesse h2bapply.com → Planos e renove em 2 minutos.

Bora manter o sonho americano em movimento! 🇺🇸

— Equipe H2BApply 🤖` }
];

const MSGS_NO_PROFILE = [
  { sub:"🚗 {nome}, seu robô está sem motorista! Falta só o perfil", body:`Oi {nome}! 👋

Você tem acesso ao H2BApply, mas o robô ainda NÃO consegue enviar nenhum currículo por um motivo simples: falta criar o seu Perfil de Currículo.

O perfil é o "motorista" do robô — é ele que carrega:
📄 Seu currículo em PDF
✉️ O assunto do e-mail (temos modelos prontos)
📝 O corpo do e-mail em inglês (modelos prontos também!)

✅ Leva 3 minutos:
1. Acesse h2bapply.com
2. Toque em "Currículos" → "Novo Perfil"
3. Siga os 3 passos — o app te guia

Depois disso é só ativar o Envio Automático e deixar o robô trabalhar por você, 24h por dia. 🇺🇸

— Equipe H2BApply 🤖` }
];

const MSGS_VIP_DESYNC = [
  { sub:"🤖 {nome}, seu robô está parado mas seu VIP está ATIVO!", body:`Oi {nome}! 👋

Nosso sistema de monitoramento detectou algo importante: você tem plano VIP ATIVO, mas seu robô de envio automático está PARADO. Ou seja: você está pagando e não está aproveitando! 😱

Na maioria dos casos isso acontece porque a conexão com o Gmail expirou e precisa ser renovada.

✅ Solução em 1 minuto:
1. Acesse h2bapply.com
2. Faça login novamente com o Google (isso renova a autorização)
3. Vá em "Envio Automático" e clique em ATIVAR

Pronto! O robô volta a trabalhar por você. 🚀

Se precisar de ajuda, responda este e-mail que a gente resolve junto!

— Equipe H2BApply 🤖` },
  { sub:"⚠️ Ei {nome}, detectamos seu VIP parado — vamos reativar?", body:`Olá {nome}! 

Notamos aqui que seu plano VIP está valendo, mas o envio automático não está rodando. Provavelmente o Google pediu uma nova autorização (isso é normal e acontece de tempos em tempos).

Reativar é simples:
1. Entre em h2bapply.com
2. Clique em "Entrar com Google" novamente
3. Ative o Envio Automático

Cada dia parado é oportunidade de vaga perdida — os empregadores H-2B respondem rápido para quem chega primeiro! 🇺🇸

— Equipe H2BApply 🤖` }
];

const MSGS_REFILL = [
  { sub:"🔄 {nome}, seu robô terminou a fila — hora de recarregar!", body:`Oi {nome}! 🎉

Boa notícia: seu robô do H2BApply enviou TODAS as candidaturas da fila. Missão cumprida!

Mas atenção: robô parado não gera entrevista. 😉

✅ Recarregue em 2 minutos:
1. Acesse h2bapply.com
2. Vá em "Envio Automático"
3. Selecione mais categorias/planilhas e clique em ATIVAR

💡 Dica: as planilhas recebem vagas novas com frequência — quem recarrega primeiro chega primeiro na caixa do empregador. 🇺🇸

— Equipe H2BApply 🤖` }
];

const MSGS_PLAN_ACTIVATED = [
  { sub:"🎉 {nome}, seu plano no H2BApply já está ativo!", body:`Oi {nome}! 👋

Boa notícia: recebemos seu comprovante, conferimos e o seu plano JÁ ESTÁ ATIVO. 🎉

✅ Pode voltar pro app agora mesmo e:
1. Acessar h2bapply.com
2. Conferir seu novo limite diário na aba "Início"
3. Ativar o Envio Automático (se o seu plano incluir)

Se algo parecer errado (dias, valor, plano), é só responder este e-mail que a gente ajusta na hora.

Bora pra cima! 🇺🇸

— Equipe H2BApply 🤖` },
  { sub:"✅ Pagamento confirmado — plano ativo no H2BApply, {nome}!", body:`Olá {nome}!

Seu pagamento foi confirmado e o plano já está valendo na sua conta. 🚀

Acesse h2bapply.com pra ver seu novo limite diário e, se o plano incluir, ligar o robô de envio automático.

Qualquer dúvida sobre a cobrança ou o plano, responda este e-mail — Andrio ou Diego respondem direto.

— Equipe H2BApply 🤖` }
];

module.exports = { MSGS_VIP_EXPIRING, MSGS_NO_PROFILE, MSGS_VIP_DESYNC, MSGS_REFILL, MSGS_PLAN_ACTIVATED };
