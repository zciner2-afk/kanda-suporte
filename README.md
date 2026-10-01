# 🤖 Kanda Freelancer Bot

Bot Telegram completo e inteligente para a plataforma **Kanda Freelancer** com proteção contra links, painel administrativo, sistema de avisos, anúncios automáticos e gerenciamento de mensagens privadas.

## ✨ Funcionalidades

### 🛡️ Proteção Contra Links
- ✅ Remove automaticamente mensagens com links em grupos
- ✅ Sistema de avisos (3 strikes = ban)
- ✅ Notifica o utilizador do aviso recebido
- ✅ Regista banimentos no Firestore
- ✅ Verifica permissões do bot antes de deletar

### 📢 Anúncios Automáticos
- ✅ 3 anúncios agendados diariamente (06h, 13h, 00h)
- ✅ Enviados para todos os grupos e utilizadores
- ✅ Configuráveis em tempo real no Firestore
- ✅ Reagendamento automático ao alterar configuração

### 💬 Conversa Privada com Relay
- ✅ Utilizadores enviam mensagens privadas ao bot
- ✅ Mensagens são encaminhadas ao admin em tempo real
- ✅ Admin responde por "reply" e mensagem vai diretamente ao utilizador
- ✅ Indicador "digitando..." para parecer mais humano
- ✅ Histórico completo no Firestore

### 🎛️ Painel Administrativo (Telegram)
- ✅ `/admin` - Menu principal
- ✅ `/jobs` - Ver trabalhos pendentes
- ✅ `/messages` - Ver mensagens privadas não lidas
- ✅ `/stats` - Estatísticas do bot
- ✅ `/banned` - Ver utilizadores banidos
- ✅ `/unban [groupId] [userId]` - Remover banimento
- ✅ `/broadcast [texto]` - Enviar anúncio a todos

### 🤖 Respostas Inteligentes
- ✅ Reconhece perguntas: "Como funciona?", "Como trabalha?"
- ✅ Responde: "Quero trabalhar", "Preciso de ajuda", "Tenho dificuldade"
- ✅ Oferece links com botões para criar conta e falar com admin
- ✅ Explica todo o processo de inscrição (5 passos)

### 📊 Persistência de Dados
- ✅ Firebase Firestore para armazenar tudo
- ✅ Regista grupos, utilizadores, avisos, bans, mensagens
- ✅ Histórico completo de ações e eventos

## 🚀 Instalação

### Pré-requisitos
- Node.js 16+
- NPM ou Yarn
- Conta Firebase com Firestore ativado
- Bot Telegram criado (@BotFather)

### Passos

1. **Clone o repositório**
```bash
git clone https://github.com/zcinerc-hash/kanda-freelancer-bot.git
cd kanda-freelancer-bot