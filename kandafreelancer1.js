require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const admin = require('firebase-admin');
const schedule = require('node-schedule');

// ============================================
// CONFIGURAÇÃO INICIAL
// ============================================

const token = process.env.TELEGRAM_BOT_TOKEN;
const adminId = process.env.ADMIN_ID;
const firestoreKey = JSON.parse(process.env.FIREBASE_CONFIG);

const bot = new TelegramBot(token, { polling: true });

admin.initializeApp({
  credential: admin.credential.cert(firestoreKey)
});

const db = admin.firestore();

// ============================================
// VARIÁVEIS GLOBAIS
// ============================================

const LINK_REGEX = /https?:\/\/[^\s]+|www\.[^\s]+/gi;
const WARNINGS = new Map();
const BAN_THRESHOLD = 3;
const SITE_URL = 'https://kandafreelancer.surge.sh';
const ADMIN_CONTACT = 'https://t.me/zuacassongo';

// Anúncios padrão (usados apenas se ainda não existir configuração no Firestore).
// Quando o painel admin for criado, ele vai ler/escrever diretamente em settings/ads,
// e o bot reagirá automaticamente (ver watchAdsSettings()).
const DEFAULT_ADS = [
  {
    time: '06:00',
    text: `📢 Anúncio Matinal — Kanda Freelancer\n\nTrabalhadores! 🌅 Aproveitem o início do dia para aceitar anúncios na plataforma!\n\nNa plataforma Kanda Freelancer:\n✅ Aceite anúncios de comerciantes\n✅ Realize tarefas online rápidas\n✅ Receba pagamento na carteira\n\n🔒 Segurança garantida - O pagamento só é liberado após aprovação!\n\n${SITE_URL}`
  },
  {
    time: '13:00',
    text: `📢 Anúncio Tarde — Kanda Freelancer\n\nOlá Freelancers! ☀️ Metade do dia passou!\n\nNovos anúncios estão disponíveis! Não perca:\n✅ Tarefas rápidas\n✅ Boa remuneração\n✅ Processo 100% seguro\n\nVenha ganhar recompensas! 💰\n${SITE_URL}`
  },
  {
    time: '00:00',
    text: `📢 Anúncio Noturno — Kanda Freelancer\n\nBoa noite, trabalhadores! 🌙\n\nAinda acordado? Temos tarefas esperando por você:\n✅ Trabalhe nos seus próprios horários\n✅ Sem investimento, apenas tempo\n✅ Construa sua reputação\n\nJunte-se à comunidade de freelancers! 🚀\n${SITE_URL}`
  }
];

let botInfo = null;          // preenchido no startup (bot.getMe())
let scheduledJobs = [];       // jobs de node-schedule ativos (para poder recriar)

// ============================================
// FUNÇÕES AUXILIARES BÁSICAS
// ============================================

async function isGroupChat(chatId) {
  try {
    const chat = await bot.getChat(chatId);
    return chat.type === 'group' || chat.type === 'supergroup';
  } catch (error) {
    console.error('Erro ao verificar tipo de chat:', error);
    return false;
  }
}

// Envia "digitando..." e só depois a mensagem, para parecer mais humano
// e para o usuário ver que o bot está a processar.
async function sendWithTyping(chatId, text, options = {}) {
  try {
    await bot.sendChatAction(chatId, 'typing');
    await new Promise((resolve) => setTimeout(resolve, 500 + Math.random() * 500));
  } catch (error) {
    // se falhar o "typing" não é crítico, seguimos para enviar a mensagem
  }
  return bot.sendMessage(chatId, text, options);
}

// Verifica se o bot é administrador do grupo e se pode apagar mensagens.
// Sem isto, o bot tentaria apagar mensagens sem permissão e falharia sempre.
async function botCanModerate(chatId) {
  if (!botInfo) return false;
  try {
    const member = await bot.getChatMember(chatId, botInfo.id);
    return (
      (member.status === 'administrator' || member.status === 'creator') &&
      member.can_delete_messages !== false
    );
  } catch (error) {
    console.error('Erro ao verificar permissões do bot no grupo:', error);
    return false;
  }
}

// ============================================
// PERSISTÊNCIA (GRUPOS, UTILIZADORES, BANS...)
// ============================================

async function registerGroup(chatId, name) {
  try {
    await db.collection('groups').doc(String(chatId)).set(
      { chatId, name, addedAt: new Date(), active: true },
      { merge: true }
    );
  } catch (error) {
    console.error('Erro ao registrar grupo:', error);
  }
}

async function registerUser(userId, userName) {
  try {
    await db.collection('users').doc(String(userId)).set(
      { userId, userName, lastSeen: new Date(), active: true },
      { merge: true }
    );
  } catch (error) {
    console.error('Erro ao registrar utilizador:', error);
  }
}

async function isUserBanned(groupId, userId) {
  try {
    const banRef = await db.collection('bans').doc(`${groupId}_${userId}`).get();
    return banRef.exists;
  } catch (error) {
    console.error('Erro ao verificar ban:', error);
    return false;
  }
}

async function banUser(groupId, userId, userName) {
  try {
    await db.collection('bans').doc(`${groupId}_${userId}`).set({
      groupId,
      userId,
      userName,
      bannedAt: new Date(),
      reason: 'Publicação de links não autorizada'
    });
    await bot.banChatMember(groupId, userId);
    return true;
  } catch (error) {
    console.error('Erro ao banir usuário:', error);
    return false;
  }
}

async function addWarning(groupId, userId, userName) {
  const key = `${groupId}_${userId}`;
  const warnings = (WARNINGS.get(key) || 0) + 1;
  WARNINGS.set(key, warnings);

  try {
    await db.collection('warnings').doc(key).set({
      groupId,
      userId,
      userName,
      warningCount: warnings,
      lastWarning: new Date()
    });
  } catch (error) {
    console.error('Erro ao adicionar aviso:', error);
  }

  return warnings;
}

// Regista a mensagem privada e devolve o ID do documento (usado para
// depois ligar a resposta do admin de volta ao utilizador certo).
async function logPrivateMessage(userId, userName, text, userMessageId) {
  try {
    const docRef = await db.collection('private_messages').add({
      userId,
      userName,
      text,
      userMessageId,
      timestamp: new Date(),
      adminViewed: false,
      responded: false
    });
    return docRef.id;
  } catch (error) {
    console.error('Erro ao registrar mensagem privada:', error);
    return null;
  }
}

async function linkPrivateMessageToAdminMessage(docId, adminMessageId) {
  if (!docId) return;
  try {
    await db.collection('private_messages').doc(docId).update({ adminMessageId });
  } catch (error) {
    console.error('Erro ao vincular mensagem ao admin:', error);
  }
}

async function findPrivateMessageByAdminReply(adminMessageId) {
  try {
    const snap = await db
      .collection('private_messages')
      .where('adminMessageId', '==', adminMessageId)
      .limit(1)
      .get();
    if (snap.empty) return null;
    const doc = snap.docs[0];
    return { id: doc.id, ...doc.data() };
  } catch (error) {
    console.error('Erro ao procurar mensagem original:', error);
    return null;
  }
}

async function markPrivateMessageResponded(docId) {
  if (!docId) return;
  try {
    await db.collection('private_messages').doc(docId).update({
      responded: true,
      adminViewed: true,
      respondedAt: new Date()
    });
  } catch (error) {
    console.error('Erro ao marcar mensagem como respondida:', error);
  }
}

async function saveJobPosting(jobData) {
  try {
    await db.collection('jobs').add({
      ...jobData,
      createdAt: new Date(),
      postedToGroups: false
    });
  } catch (error) {
    console.error('Erro ao salvar trabalho:', error);
  }
}

// ============================================
// TECLADOS (BOTÕES LADO A LADO)
// ============================================

function mainMenuKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '📋 Como Funciona', callback_data: 'como_funciona' },
          { text: '🌐 Criar Conta', url: SITE_URL }
        ],
        [
          { text: '💬 Falar com Admin', url: ADMIN_CONTACT }
        ]
      ]
    }
  };
}

function groupWelcomeKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '🌐 Ver Plataforma', url: SITE_URL },
          { text: '💬 Falar em Privado', url: `https://t.me/${botInfo ? botInfo.username : ''}` }
        ]
      ]
    }
  };
}

// ============================================
// COMANDOS DE GRUPO / GERAIS
// ============================================

bot.onText(/^\/start$/, async (msg) => {
  const chatId = msg.chat.id;
  const isGroup = await isGroupChat(chatId);

  if (isGroup) {
    await registerGroup(chatId, msg.chat.title);
    const welcomeMsg = `🤖 *Kanda Freelancer Bot Ativado!*\n\n✅ Sistema de proteção contra links ativado\n✅ Anúncios automáticos configurados\n✅ Painel administrativo disponível\n\nPara mais informações, envie mensagens privadas ao bot!`;
    await sendWithTyping(chatId, welcomeMsg, { parse_mode: 'Markdown', ...groupWelcomeKeyboard() });
  } else {
    await registerUser(msg.from.id, msg.from.username || msg.from.first_name);
    await sendWithTyping(
      chatId,
      '👋 Olá! Envie-me mensagens privadas e irei responder assim que possível.',
      mainMenuKeyboard()
    );
  }
});

const HELP_TEXT = `📚 *Como Funciona a Kanda Freelancer*\n\n
*1. Para Freelancers:*
✅ Crie conta na plataforma
✅ Escolha tipo de conta: Freelancer
✅ Submeta verificação (30min - 1h)
✅ Aceite anúncios e trabalhe
✅ Receba pagamento na carteira\n
*2. Segurança:*
🔒 Sem investimento de dinheiro
💰 Receba comissão por tarefa
⏱️ Você só investe seu tempo\n
*3. Contato:*
👤 Admin: @zuacassongo
📧 Dúvidas? Mensagem privada ao bot\n
🌐 ${SITE_URL}`;

bot.onText(/\?/, async (msg) => {
  await sendWithTyping(msg.chat.id, HELP_TEXT, { parse_mode: 'Markdown', ...mainMenuKeyboard() });
});

bot.onText(/como funciona|como trabaja|como trabalha/i, async (msg) => {
  const response = `📢 *Informações da Kanda Freelancer*\n\n
*Como Funciona:*\n
1️⃣ Crie sua conta
2️⃣ Escolha tipo: Freelancer
3️⃣ Submeta verificação
4️⃣ Aguarde 30min - 1h
5️⃣ Aceite anúncios e trabalhe\n
*Ganhe:*
💵 Comissão por tarefa
📱 Pagamento direto na carteira
🏆 Construa reputação\n
*Importante:*
✋ ZERO investimento
⏰ Trabalhe seus horários
🔒 100% seguro`;

  await sendWithTyping(msg.chat.id, response, { parse_mode: 'Markdown', ...mainMenuKeyboard() });
});

bot.onText(/quero trabalhar|preciso de ajuda|tenho dificuldade/i, async (msg) => {
  const response = `💼 *Vou te Ajudar!*\n\n
📋 *Passos para começar:*\n
1️⃣ Acesse: ${SITE_URL}
2️⃣ Clique em "Criar Conta"
3️⃣ Selecione tipo: FREELANCER
4️⃣ Preencha dados corretamente
5️⃣ Submeta verificação\n
⏳ *Aguarde aprovação (30min - 1h)*\n
6️⃣ Retorne e clique "Aceitar Anúncio"
7️⃣ Complete tarefa
8️⃣ Envie prova (print/dados)
9️⃣ Ganhe sua recompensa!\n
*Dúvidas?*
👤 Contato: @zuacassongo
🤖 Ou fale comigo em privado`;

  await sendWithTyping(msg.chat.id, response, { parse_mode: 'Markdown', ...mainMenuKeyboard() });
});

// Responde ao clique no botão "Como Funciona" sem sair do chat
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;

  if (query.data === 'como_funciona') {
    await bot.answerCallbackQuery(query.id);
    await sendWithTyping(chatId, HELP_TEXT, { parse_mode: 'Markdown' });
  }
});

// ============================================
// RELAY: CONVERSA PRIVADA <-> ADMIN
// (utilizador escreve, admin responde em privado ao bot
//  respondendo à mensagem encaminhada, sem interromper o fluxo)
// ============================================

async function handleAdminChat(msg) {
  const text = msg.text || '';

  // O admin está a RESPONDER a uma mensagem que o bot encaminhou de um utilizador
  if (msg.reply_to_message) {
    const original = await findPrivateMessageByAdminReply(msg.reply_to_message.message_id);
    if (original) {
      await sendWithTyping(original.userId, `💬 *Resposta do Admin:*\n\n${text}`, {
        parse_mode: 'Markdown'
      });
      await markPrivateMessageResponded(original.id);
      await bot.sendMessage(msg.chat.id, `✅ Resposta enviada a @${original.userName || original.userId}.`);
      return true; // tratado, não continuar
    }
  }

  return false; // não era uma resposta a um utilizador, segue fluxo normal (comandos /admin, etc.)
}

// ============================================
// MENSAGENS GERAIS (PRIVADO, GRUPO, MÍDIA)
// ============================================

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const userName = msg.from.username || msg.from.first_name;
  const text = msg.text || '';

  const isGroup = await isGroupChat(chatId);

  // ---------- CHAT PRIVADO DO PRÓPRIO ADMIN ----------
  if (!isGroup && chatId === parseInt(adminId)) {
    if (text && !text.startsWith('/')) {
      const handled = await handleAdminChat(msg);
      if (handled) return;
    }
    return; // comandos de admin (/admin, /jobs...) são tratados pelos onText próprios
  }

  // ---------- MENSAGENS PRIVADAS DE UTILIZADORES COMUNS ----------
  if (!isGroup) {
    await registerUser(userId, userName);

    if (text && !text.startsWith('/')) {
      const docId = await logPrivateMessage(userId, userName, text, msg.message_id);

      const sentToAdmin = await sendWithTyping(
        adminId,
        `📨 *Mensagem Privada*\n\nDe: @${userName} (${userId})\n\n"${text}"\n\nResponda a ESTA mensagem para falar diretamente com o utilizador.`,
        { parse_mode: 'Markdown' }
      );

      await linkPrivateMessageToAdminMessage(docId, sentToAdmin.message_id);
      await sendWithTyping(chatId, '✅ Sua mensagem foi recebida! O administrador responderá em breve.');
    }
    return;
  }

  // ---------- DENTRO DE GRUPOS ----------
  if (isGroup) {
    // O bot não deve processar fotos, vídeos, stickers, documentos, etc.
    // Só lê texto. Se tiver permissão de admin no grupo, remove a mídia.
    const isMedia =
      msg.photo || msg.video || msg.animation || msg.document || msg.sticker || msg.video_note || msg.voice;

    if (isMedia) {
      if (await botCanModerate(chatId)) {
        try {
          await bot.deleteMessage(chatId, msg.message_id);
        } catch (error) {
          console.error('Erro ao apagar mídia no grupo:', error);
        }
      }
      // sem permissão de admin, o bot simplesmente ignora a mídia (não lê, não processa)
      return;
    }

    if (!text) return; // ignora qualquer outro tipo de conteúdo não textual

    const hasLink = LINK_REGEX.test(text);
    if (!hasLink) return;

    const isBanned = await isUserBanned(chatId, userId);
    if (isBanned) return; // já banido, nada a fazer

    const canModerate = await botCanModerate(chatId);

    if (canModerate) {
      try {
        await bot.deleteMessage(chatId, msg.message_id);
      } catch (error) {
        console.error('Erro ao deletar mensagem com link:', error);
      }
    }

    const warningCount = await addWarning(chatId, userId, userName);

    if (warningCount >= BAN_THRESHOLD) {
      if (canModerate) {
        await banUser(chatId, userId, userName);
        await sendWithTyping(
          chatId,
          `⛔ *Usuário Banido*\n\n@${userName} foi removido por publicação repetida de links.`,
          { parse_mode: 'Markdown' }
        );
      } else {
        await sendWithTyping(
          adminId,
          `⚠️ @${userName} atingiu ${BAN_THRESHOLD} avisos por links no grupo "${msg.chat.title}", mas o bot não é administrador e não pôde banir.`
        );
      }
    } else {
      const warningMsg = await sendWithTyping(
        chatId,
        `⚠️ *Aviso para @${userName}*\n\n🚫 Links não são permitidos aqui!\n\n${
          canModerate ? '❌ Sua mensagem foi removida.\n' : ''
        }⚠️ Aviso ${warningCount}/${BAN_THRESHOLD}\n\n⛔ Se receber ${BAN_THRESHOLD} avisos, será banido!\n\n📌 Envie mensagens privadas ao bot para sugestões.`,
        { parse_mode: 'Markdown' }
      );

      setTimeout(() => {
        bot.deleteMessage(chatId, warningMsg.message_id).catch(() => {});
      }, 30000);
    }
  }
});

// ============================================
// COMANDOS ADMINISTRATIVOS (via Telegram — sem painel web ainda)
// ============================================

function isAdmin(chatId) {
  return chatId === parseInt(adminId);
}

bot.onText(/\/admin/, async (msg) => {
  const chatId = msg.chat.id;
  if (!isAdmin(chatId)) {
    await sendWithTyping(chatId, '❌ Você não tem permissão para usar este comando.');
    return;
  }

  const adminPanel = `
🎛️ *PAINEL ADMINISTRATIVO*\n
/jobs - Ver trabalhos pendentes
/messages - Ver mensagens privadas não lidas
/broadcast [texto] - Enviar anúncio a todos os grupos e utilizadores
/stats - Ver estatísticas
/banned - Ver usuários banidos
/unban [groupId] [userId] - Remover banimento`;

  await sendWithTyping(chatId, adminPanel, { parse_mode: 'Markdown' });
});

bot.onText(/\/jobs/, async (msg) => {
  const chatId = msg.chat.id;
  if (!isAdmin(chatId)) return sendWithTyping(chatId, '❌ Acesso negado.');

  try {
    const jobsSnapshot = await db.collection('jobs').where('postedToGroups', '==', false).get();

    if (jobsSnapshot.empty) {
      await sendWithTyping(chatId, '📭 Nenhum trabalho pendente.');
      return;
    }

    let jobsList = '📋 *TRABALHOS PENDENTES*\n\n';
    jobsSnapshot.forEach((doc, index) => {
      const job = doc.data();
      jobsList += `${index + 1}. ${job.title}\n`;
      jobsList += `   💰 Valor: R$ ${job.value}\n`;
      jobsList += `   📝 ${(job.description || '').substring(0, 50)}...\n`;
      jobsList += `   ID: ${doc.id}\n\n`;
    });
    jobsList += '\nUse /postar_trabalho [ID] para publicar um trabalho';

    await sendWithTyping(chatId, jobsList, { parse_mode: 'Markdown' });
  } catch (error) {
    console.error('Erro ao listar trabalhos:', error);
    await sendWithTyping(chatId, '❌ Erro ao listar trabalhos.');
  }
});

bot.onText(/\/messages/, async (msg) => {
  const chatId = msg.chat.id;
  if (!isAdmin(chatId)) return sendWithTyping(chatId, '❌ Acesso negado.');

  try {
    const messagesSnapshot = await db
      .collection('private_messages')
      .where('adminViewed', '==', false)
      .orderBy('timestamp', 'desc')
      .limit(5)
      .get();

    if (messagesSnapshot.empty) {
      await sendWithTyping(chatId, '📭 Nenhuma mensagem privada não lida.');
      return;
    }

    let messagesList = '💬 *MENSAGENS PRIVADAS*\n\n';
    messagesSnapshot.forEach((doc, index) => {
      const data = doc.data();
      messagesList += `${index + 1}. @${data.userName} (${data.userId})\n`;
      messagesList += `   "${data.text}"\n\n`;
    });
    messagesList += 'ℹ️ Para responder, vá à mensagem encaminhada diretamente e clique em "Responder".';

    await sendWithTyping(chatId, messagesList, { parse_mode: 'Markdown' });
  } catch (error) {
    console.error('Erro ao listar mensagens:', error);
    await sendWithTyping(chatId, '❌ Erro ao listar mensagens.');
  }
});

bot.onText(/\/stats/, async (msg) => {
  const chatId = msg.chat.id;
  if (!isAdmin(chatId)) return sendWithTyping(chatId, '❌ Acesso negado.');

  try {
    const [groupsSnapshot, usersSnapshot, jobsSnapshot, bansSnapshot, messagesSnapshot] = await Promise.all([
      db.collection('groups').where('active', '==', true).get(),
      db.collection('users').where('active', '==', true).get(),
      db.collection('jobs').get(),
      db.collection('bans').get(),
      db.collection('private_messages').get()
    ]);

    const stats = `📊 *ESTATÍSTICAS DO BOT*\n
👥 Grupos ativos: ${groupsSnapshot.size}
🙋 Utilizadores: ${usersSnapshot.size}
💼 Trabalhos: ${jobsSnapshot.size}
⛔ Banimentos: ${bansSnapshot.size}
💬 Mensagens: ${messagesSnapshot.size}`;

    await sendWithTyping(chatId, stats, { parse_mode: 'Markdown' });
  } catch (error) {
    console.error('Erro ao obter estatísticas:', error);
    await sendWithTyping(chatId, '❌ Erro ao obter estatísticas.');
  }
});

bot.onText(/\/banned/, async (msg) => {
  const chatId = msg.chat.id;
  if (!isAdmin(chatId)) return sendWithTyping(chatId, '❌ Acesso negado.');

  try {
    const bansSnapshot = await db.collection('bans').limit(20).get();
    if (bansSnapshot.empty) {
      await sendWithTyping(chatId, '📭 Nenhum usuário banido.');
      return;
    }

    let list = '⛔ *USUÁRIOS BANIDOS*\n\n';
    bansSnapshot.forEach((doc) => {
      const b = doc.data();
      list += `• @${b.userName} — grupo ${b.groupId}, user ${b.userId}\n`;
    });
    list += '\nUse /unban [groupId] [userId] para remover um banimento.';

    await sendWithTyping(chatId, list, { parse_mode: 'Markdown' });
  } catch (error) {
    console.error('Erro ao listar banidos:', error);
    await sendWithTyping(chatId, '❌ Erro ao listar banidos.');
  }
});

bot.onText(/\/unban (-?\d+) (\d+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (!isAdmin(chatId)) return sendWithTyping(chatId, '❌ Acesso negado.');

  const groupId = match[1];
  const userId = match[2];

  try {
    await db.collection('bans').doc(`${groupId}_${userId}`).delete();
    await bot.unbanChatMember(groupId, userId, { only_if_banned: true }).catch(() => {});
    await sendWithTyping(chatId, `✅ Banimento removido para o utilizador ${userId} no grupo ${groupId}.`);
  } catch (error) {
    console.error('Erro ao remover banimento:', error);
    await sendWithTyping(chatId, '❌ Erro ao remover banimento.');
  }
});

bot.onText(/\/broadcast ([\s\S]+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (!isAdmin(chatId)) return sendWithTyping(chatId, '❌ Acesso negado.');

  const text = match[1];
  await sendWithTyping(chatId, '📤 A enviar anúncio a todos os grupos e utilizadores...');

  const result = await broadcastToAll(text);

  await bot.sendMessage(
    chatId,
    `✅ Anúncio enviado!\n📤 Grupos: ${result.groupsSent}/${result.groupsTotal}\n📤 Utilizadores: ${result.usersSent}/${result.usersTotal}`
  );
});

// ============================================
// ANÚNCIOS AGENDADOS (3x por dia, grupos + utilizadores)
// Configuráveis em settings/ads no Firestore — preparado para
// quando o painel admin existir.
// ============================================

async function getAdsSettings() {
  try {
    const doc = await db.collection('settings').doc('ads').get();
    if (doc.exists && Array.isArray(doc.data().ads) && doc.data().ads.length > 0) {
      return doc.data().ads;
    }
    // ainda não existe configuração: cria com os valores padrão
    await db.collection('settings').doc('ads').set({ ads: DEFAULT_ADS, updatedAt: new Date() });
    return DEFAULT_ADS;
  } catch (error) {
    console.error('Erro ao obter configuração de anúncios, a usar padrão:', error);
    return DEFAULT_ADS;
  }
}

async function broadcastToAll(text) {
  const [groupsSnapshot, usersSnapshot] = await Promise.all([
    db.collection('groups').where('active', '==', true).get(),
    db.collection('users').where('active', '==', true).get()
  ]);

  let groupsSent = 0;
  let usersSent = 0;

  for (const doc of groupsSnapshot.docs) {
    const groupId = doc.data().chatId;
    try {
      await bot.sendMessage(groupId, text, { parse_mode: 'Markdown' });
      groupsSent++;
    } catch (error) {
      console.error(`Erro ao enviar anúncio para grupo ${groupId}:`, error.message);
      if (error.response && error.response.statusCode === 403) {
        await db.collection('groups').doc(String(groupId)).update({ active: false }).catch(() => {});
      }
    }
  }

  for (const doc of usersSnapshot.docs) {
    const userId = doc.data().userId;
    try {
      await bot.sendMessage(userId, text, { parse_mode: 'Markdown' });
      usersSent++;
    } catch (error) {
      console.error(`Erro ao enviar anúncio para utilizador ${userId}:`, error.message);
      if (error.response && error.response.statusCode === 403) {
        await db.collection('users').doc(String(userId)).update({ active: false }).catch(() => {});
      }
    }
  }

  return {
    groupsSent,
    groupsTotal: groupsSnapshot.size,
    usersSent,
    usersTotal: usersSnapshot.size
  };
}

async function scheduleAnnouncements() {
  // cancela jobs anteriores antes de recriar (permite reagendar em tempo real)
  scheduledJobs.forEach((job) => job.cancel());
  scheduledJobs = [];

  const ads = await getAdsSettings();

  ads.forEach((ad) => {
    const job = schedule.scheduleJob(ad.time, async () => {
      console.log(`⏰ A disparar anúncio das ${ad.time}...`);
      const result = await broadcastToAll(ad.text);
      console.log(
        `✅ Anúncio das ${ad.time} enviado — grupos ${result.groupsSent}/${result.groupsTotal}, utilizadores ${result.usersSent}/${result.usersTotal}`
      );
    });
    scheduledJobs.push(job);
  });

  console.log(`✅ ${ads.length} anúncios agendados com sucesso`);
}

// Reagenda automaticamente sempre que a configuração de anúncios mudar no Firestore
// (útil quando o futuro painel admin editar os horários/textos diretamente na base de dados)
function watchAdsSettings() {
  db.collection('settings')
    .doc('ads')
    .onSnapshot((doc) => {
      if (doc.exists) {
        console.log('🔄 Configuração de anúncios alterada, a reagendar...');
        scheduleAnnouncements();
      }
    });
}

// ============================================
// INICIALIZAÇÃO
// ============================================

(async () => {
  try {
    botInfo = await bot.getMe();
    console.log(`🤖 Bot identificado como @${botInfo.username}`);
  } catch (error) {
    console.error('Erro ao obter informações do bot:', error);
  }

  await scheduleAnnouncements();
  watchAdsSettings();

  console.log('🤖 Bot Kanda Freelancer iniciado com sucesso!');
  console.log('✅ Indicador de "digitando..." ativo');
  console.log('✅ Bot só processa texto em grupos (mídia é ignorada/removida)');
  console.log('✅ Sistema de proteção de links ativo (verifica permissões de admin)');
  console.log('✅ Conversa privada com relay para o admin (responder = reply)');
  console.log('✅ Anúncios agendados para grupos e utilizadores');
})();

bot.on('polling_error', (error) => {
  console.error('Erro de polling:', error);
});

module.exports = bot;