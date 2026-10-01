require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const admin = require('firebase-admin');
const schedule = require('node-schedule');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const path = require('path');

// ============================================
// VALIDAÇÃO DAS VARIÁVEIS DE AMBIENTE
// ============================================

const token = process.env.TELEGRAM_BOT_TOKEN;
const adminId = process.env.ADMIN_ID;
const firebaseConfigRaw = process.env.FIREBASE_CONFIG;

if (!token) {
  console.error('❌ ERRO FATAL: TELEGRAM_BOT_TOKEN não definida.');
  process.exit(1);
}
if (!adminId || Number.isNaN(parseInt(adminId, 10))) {
  console.error('❌ ERRO FATAL: ADMIN_ID não definida (ou não é numérica).');
  process.exit(1);
}
if (!firebaseConfigRaw) {
  console.error('❌ ERRO FATAL: FIREBASE_CONFIG não definida.');
  process.exit(1);
}

let firestoreKey;
try {
  firestoreKey = JSON.parse(firebaseConfigRaw);
} catch (error) {
  console.error('❌ ERRO FATAL: FIREBASE_CONFIG não é um JSON válido:', error.message);
  process.exit(1);
}

const ADMIN_ID_NUM = parseInt(adminId, 10);

// ============================================
// CONFIGURAÇÃO DA IA (SPACE DO TEU MODELO)
// ============================================
//   KANDA_AI_URL          URL completa do endpoint (ex.: https://user-space.hf.space/chat)
//                         Sem URL, a IA fica desligada e as mensagens vão só para o admin.
//   KANDA_AI_TOKEN        (opcional) enviado como "Authorization: Bearer ..."
//   KANDA_AI_FORMAT       'json' (padrão) -> POST { user_id, message, channel, new_topic, user_name }
//                         'gradio'        -> POST { data: [ message ] }
//   KANDA_AI_TIMEOUT_MS   tempo máximo de espera por tentativa (padrão 45000)
//   KANDA_AI_MAX_QUEUE    máx. de mensagens por utilizador à espera da IA (padrão 3)
const AI_URL = (process.env.KANDA_AI_URL || '').trim();
const AI_TOKEN = (process.env.KANDA_AI_TOKEN || '').trim();
const AI_FORMAT = (process.env.KANDA_AI_FORMAT || 'json').trim().toLowerCase();
const AI_TIMEOUT_MS = parseInt(process.env.KANDA_AI_TIMEOUT_MS || '45000', 10);
const AI_MAX_QUEUE = Math.max(1, parseInt(process.env.KANDA_AI_MAX_QUEUE || '3', 10));

if (AI_URL && typeof fetch !== 'function') {
  console.error('⚠️ KANDA_AI_URL definida mas este Node não tem fetch (precisa de Node 18+). IA desligada.');
}
const AI_ENABLED = AI_URL.length > 0 && typeof fetch === 'function';

// ============================================
// CONFIGURAÇÃO INICIAL (TELEGRAM + FIREBASE)
// ============================================

// USE_WEBHOOK=true -> o Telegram chama o nosso servidor (sem polling, sem 409 nos deploys).
// Por omissão: polling.
const USE_WEBHOOK = String(process.env.USE_WEBHOOK || '').toLowerCase() === 'true';
const WEBHOOK_PATH = `/webhook/${token}`;

// Ao arrancar, o bot limpa qualquer webhook/sessão antiga. Por omissão também descarta
// os updates acumulados (comportamento original). Define DROP_PENDING_UPDATES=false para
// NÃO perder mensagens enviadas enquanto o bot esteve em baixo (ex.: durante um deploy).
const DROP_PENDING_UPDATES = String(process.env.DROP_PENDING_UPDATES || 'true').toLowerCase() !== 'false';

// Por omissão o bot responde ao "?" também nos grupos (comportamento original).
// QUESTION_HELP_IN_GROUPS=false desliga isso nos grupos (em privado não muda nada).
const QUESTION_HELP_IN_GROUPS = String(process.env.QUESTION_HELP_IN_GROUPS || 'true').toLowerCase() !== 'false';

const ALLOWED_UPDATES = ['message', 'callback_query', 'my_chat_member'];

// O polling só arranca no fim da inicialização (autoStart: false).
const bot = new TelegramBot(token, {
  polling: USE_WEBHOOK
    ? false
    : { autoStart: false, params: { allowed_updates: JSON.stringify(ALLOWED_UPDATES) } }
});

try {
  admin.initializeApp({ credential: admin.credential.cert(firestoreKey) });
  console.log('✅ Firebase inicializado');
} catch (error) {
  console.error('❌ ERRO FATAL: falha ao inicializar o Firebase:', error.message);
  process.exit(1);
}

const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;

// ============================================
// REDE DE SEGURANÇA GLOBAL
// ============================================

process.on('unhandledRejection', (reason) => {
  console.error('⚠️  Unhandled Rejection (bot continua a correr):', (reason && reason.message) || reason);
});

process.on('uncaughtException', (error) => {
  console.error('⚠️  Uncaught Exception (bot continua a correr):', (error && error.message) || error);
});

function safeHandler(handler) {
  return async (...args) => {
    try {
      await handler(...args);
    } catch (error) {
      console.error('Erro não tratado num handler do bot:', error && error.message ? error.message : error);
    }
  };
}

// ============================================
// VARIÁVEIS GLOBAIS
// ============================================

const WARNINGS = new Map();
const BAN_THRESHOLD = 3;
const SITE_URL = 'https://kandafreelancer.surge.sh';
const ADMIN_CONTACT = 'https://t.me/zuacassongo';

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

let botInfo = null;
let scheduledJobs = [];

// Grupos já confirmados nesta execução (evita escrever no Firestore a cada mensagem)
const registeredGroupIds = new Set();

// IA: utilizadores cujo próximo pedido leva new_topic=true (/start, /novo)
const AI_RESET_NEXT = new Set();
// IA: pedidos por utilizador em fila / em curso (as mensagens de cada utilizador são atendidas por ordem)
const AI_CHAINS = new Map();
const AI_PENDING = new Map();

// ============================================
// [KEYWORDS] Palavras-chave configuráveis pelo painel
// ============================================
// keywords/{id} = { pattern, response, matchType: 'contains'|'exact'|'regex', active }
let KEYWORDS_CACHE = [];

function watchKeywords() {
  db.collection('keywords').onSnapshot(
    (snap) => {
      KEYWORDS_CACHE = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
      console.log(`🔑 Palavras-chave sincronizadas (${KEYWORDS_CACHE.length} no total).`);
    },
    (error) => console.error('Erro no listener de palavras-chave:', error)
  );
}

function matchKeyword(text, keyword) {
  if (keyword.active === false) return false;
  if (!keyword.pattern) return false;
  const t = (text || '').toLowerCase().trim();
  const p = String(keyword.pattern).toLowerCase().trim();
  if (!t || !p) return false;

  const type = keyword.matchType || 'contains';
  if (type === 'exact') {
    return t === p || t.split(/\s+/).includes(p);
  }
  if (type === 'regex') {
    try {
      return new RegExp(keyword.pattern, 'i').test(text || '');
    } catch (error) {
      console.error(`Palavra-chave regex inválida (id=${keyword.id}):`, error.message);
      return false;
    }
  }
  return t.includes(p);
}

function findKeywordResponse(text) {
  for (const keyword of KEYWORDS_CACHE) {
    if (matchKeyword(text, keyword)) return keyword;
  }
  return null;
}

// ============================================
// FUNÇÕES AUXILIARES BÁSICAS
// ============================================

function isGroupChatType(chatType) {
  return chatType === 'group' || chatType === 'supergroup';
}

async function isGroupChat(chatId) {
  try {
    const chat = await bot.getChat(chatId);
    return isGroupChatType(chat.type);
  } catch (error) {
    console.error('Erro ao verificar tipo de chat:', error.message);
    return false;
  }
}

// No Telegram, chat_id de grupos/supergrupos é negativo; o de utilizadores é positivo.
function chatKind(chatId) {
  return Number(chatId) < 0 ? 'group' : 'user';
}

// @username se existir, senão o primeiro nome
function displayName(from) {
  if (!from) return 'utilizador';
  return from.username ? `@${from.username}` : from.first_name || String(from.id);
}

// "João Silva (@joao) — ID 123"
function describeUser(from) {
  const name = [from.first_name, from.last_name].filter(Boolean).join(' ') || 'Sem nome';
  return `${name}${from.username ? ` (@${from.username})` : ''} — ID ${from.id}`;
}

function telegramReason(error) {
  const body = error && error.response && error.response.body;
  return (body && body.description) || (error && error.message) || 'erro desconhecido';
}

function isPermanentTelegramError(error) {
  const body = (error && error.response && error.response.body) || {};
  const desc = (body.description || (error && error.message) || '').toLowerCase();
  const statusCode = error && error.response && error.response.statusCode;

  if (statusCode === 403) return true;
  return (
    desc.includes('chat not found') ||
    desc.includes('bot was blocked') ||
    desc.includes('user is deactivated') ||
    desc.includes('bot was kicked') ||
    desc.includes('peer_id_invalid')
  );
}

function isParseEntitiesError(error) {
  const body = (error && error.response && error.response.body) || {};
  const desc = (body.description || (error && error.message) || '').toLowerCase();
  return desc.includes("can't parse entities") || desc.includes('can\u2019t parse entities');
}

// Migração de grupo -> supergrupo (novo chat_id) ou desativação em erro permanente.
// Erros transitórios (rede, rate-limit, parsing) não mexem em nada.
async function handleSendError(error, kind, oldId) {
  const params = error && error.response && error.response.body && error.response.body.parameters;
  const newId = params && params.migrate_to_chat_id;

  if (newId) {
    console.log(`🔁 Chat ${oldId} migrou para supergrupo (${newId}). A atualizar registo...`);
    try {
      const collection = kind === 'group' ? 'groups' : 'users';
      const oldRef = db.collection(collection).doc(String(oldId));
      const oldSnap = await oldRef.get();
      const oldData = oldSnap.exists ? oldSnap.data() : {};
      await db.collection(collection).doc(String(newId)).set(
        { ...oldData, chatId: newId, active: true, status: 'active', migratedFrom: String(oldId) },
        { merge: true }
      );
      await oldRef.set({ active: false, status: 'migrated', migratedTo: String(newId) }, { merge: true });
      registeredGroupIds.delete(String(oldId));
      registeredGroupIds.add(String(newId));
    } catch (migrateError) {
      console.error('Erro ao migrar chat_id de supergrupo:', migrateError.message);
    }
    return 'migrated';
  }

  if (isPermanentTelegramError(error)) {
    try {
      const collection = kind === 'group' ? 'groups' : 'users';
      await db.collection(collection).doc(String(oldId)).set(
        { active: false, status: 'removed' },
        { merge: true }
      );
      if (kind === 'group') registeredGroupIds.delete(String(oldId));
    } catch (updateError) {
      console.error('Erro ao marcar destino como inativo:', updateError.message);
    }
    return 'deactivated';
  }

  return 'transient';
}

// Envia texto livre tentando Markdown; se o Telegram rejeitar a formatação
// ("can't parse entities"), reenvia o MESMO texto como texto simples.
async function sendTextTolerant(chatId, text, extraOptions = {}) {
  try {
    return await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', ...extraOptions });
  } catch (error) {
    if (isParseEntitiesError(error)) {
      console.warn(`⚠️  Markdown malformado para ${chatId} — reenviando como texto simples.`);
      const { parse_mode, ...rest } = extraOptions;
      return await bot.sendMessage(chatId, text, rest);
    }
    throw error;
  }
}

// "digitando..." + mensagem. Devolve a mensagem enviada (com message_id).
async function sendWithTyping(chatId, text, options = {}) {
  try {
    await bot.sendChatAction(chatId, 'typing');
    await new Promise((resolve) => setTimeout(resolve, 500 + Math.random() * 500));
  } catch (error) {
    // "typing" não é crítico
  }

  try {
    if (options && options.parse_mode) {
      return await sendTextTolerant(chatId, text, options);
    }
    return await bot.sendMessage(chatId, text, options);
  } catch (error) {
    console.error(`Erro ao enviar mensagem para ${chatId}:`, error.message);
    await handleSendError(error, chatKind(chatId), chatId).catch(() => {});
    throw error;
  }
}

async function botCanModerate(chatId) {
  if (!botInfo) return false;
  try {
    const member = await bot.getChatMember(chatId, botInfo.id);
    return (
      (member.status === 'administrator' || member.status === 'creator') &&
      member.can_delete_messages !== false
    );
  } catch (error) {
    console.error('Erro ao verificar permissões do bot no grupo:', error.message);
    return false;
  }
}

async function botCanRestrict(chatId) {
  if (!botInfo) return false;
  try {
    const member = await bot.getChatMember(chatId, botInfo.id);
    return (
      (member.status === 'administrator' || member.status === 'creator') &&
      member.can_restrict_members !== false
    );
  } catch (error) {
    return false;
  }
}

// Sem flag global (g): nunca depende de lastIndex entre chamadas.
function containsLink(text) {
  return /https?:\/\/[^\s]+|www\.[^\s]+/i.test(text || '');
}

// ============================================
// PERSISTÊNCIA (GRUPOS, UTILIZADORES, BANS, MENSAGENS...)
// ============================================

async function registerGroup(chatId, name) {
  try {
    await db.collection('groups').doc(String(chatId)).set(
      { chatId, name, addedAt: new Date(), active: true, status: 'active' },
      { merge: true }
    );
    registeredGroupIds.add(String(chatId));
  } catch (error) {
    console.error('Erro ao registrar grupo:', error);
  }
}

// Evento my_chat_member: o bot é considerado "fora" só se status = left/kicked
// (lista negra), para não perder grupos em que o bot ficou "restricted".
async function registerGroupFromChatMember(upd) {
  try {
    const chat = upd.chat || {};
    const from = upd.from || {};
    const newStatus = upd.new_chat_member && upd.new_chat_member.status;
    const isActiveMember = !['left', 'kicked'].includes(newStatus);

    const addedByName = [from.first_name, from.last_name]
      .filter(Boolean)
      .join(' ')
      .concat(from.username ? ` (@${from.username})` : '')
      .trim() || null;

    await db.collection('groups').doc(String(chat.id)).set(
      {
        chatId: chat.id,
        title: chat.title || chat.username || String(chat.id),
        type: chat.type || null,
        status: isActiveMember ? 'active' : 'removed',
        rawStatus: newStatus || null,
        addedBy: from.id || null,
        addedByName,
        addedAt: new Date(),
        name: chat.title || chat.username || String(chat.id),
        active: isActiveMember
      },
      { merge: true }
    );

    if (isActiveMember) registeredGroupIds.add(String(chat.id));
    else registeredGroupIds.delete(String(chat.id));

    console.log(`👥 my_chat_member: grupo "${chat.title || chat.id}" -> status "${newStatus}"`);

    if (newStatus === 'restricted' && adminId) {
      await sendWithTyping(
        adminId,
        `⚠️ O bot foi adicionado ao grupo "${chat.title || chat.id}" mas ficou com permissões restringidas (status "restricted"). Pode ser necessário ajustar as definições do grupo para o bot funcionar corretamente.`
      ).catch(() => {});
    }
  } catch (error) {
    console.error('Erro ao registrar grupo via my_chat_member:', error);
  }
}

// Rede de segurança: qualquer mensagem de grupo confirma o grupo como ativo.
async function ensureGroupRegistered(chat) {
  if (!chat || !chat.id) return;
  const chatIdStr = String(chat.id);
  if (registeredGroupIds.has(chatIdStr)) return;

  try {
    await db.collection('groups').doc(chatIdStr).set(
      {
        chatId: chat.id,
        title: chat.title || chat.username || chatIdStr,
        type: chat.type || null,
        status: 'active',
        active: true,
        name: chat.title || chat.username || chatIdStr,
        lastSeenAt: new Date()
      },
      { merge: true }
    );
    registeredGroupIds.add(chatIdStr);
    console.log(`👥 [fallback via mensagem] Grupo "${chat.title || chatIdStr}" confirmado/ativado.`);
  } catch (error) {
    console.error('Erro ao garantir registo do grupo (fallback via mensagem):', error.message);
  }
}

// Confirma junto do Telegram, grupo a grupo, se o bot ainda lá está.
async function reconcileGroups() {
  if (!botInfo) return { checked: 0, fixed: 0 };

  const snap = await db.collection('groups').get();
  let checked = 0;
  let fixed = 0;

  for (const doc of snap.docs) {
    const group = doc.data();
    if (group.status === 'migrated') continue;
    const chatId = group.chatId || doc.id;
    checked++;
    try {
      const member = await bot.getChatMember(chatId, botInfo.id);
      const stillActive = !['left', 'kicked'].includes(member.status);
      if (stillActive !== !!group.active) {
        await doc.ref.set(
          { active: stillActive, status: stillActive ? 'active' : 'removed', rawStatus: member.status },
          { merge: true }
        );
        fixed++;
        console.log(`🔧 Reconciliado grupo "${group.title || chatId}": active=${stillActive} (Telegram: ${member.status})`);
      }
      if (stillActive) registeredGroupIds.add(String(chatId));
    } catch (error) {
      if (isPermanentTelegramError(error) && group.active) {
        await doc.ref.set({ active: false, status: 'removed' }, { merge: true });
        fixed++;
        console.log(`🔧 Reconciliado grupo "${group.title || chatId}": marcado inativo (${error.message})`);
      }
    }
  }

  return { checked, fixed };
}

async function registerUser(fromInfo) {
  try {
    await db.collection('users').doc(String(fromInfo.id)).set(
      {
        userId: fromInfo.id,
        username: fromInfo.username || null,
        firstName: fromInfo.first_name || null,
        lastName: fromInfo.last_name || null,
        userName: fromInfo.username || fromInfo.first_name,
        lastSeen: new Date(),
        active: true
      },
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

async function restrictUser(groupId, userId, minutes = 60) {
  try {
    const untilDate = Math.floor(Date.now() / 1000) + minutes * 60;
    await bot.restrictChatMember(groupId, userId, {
      until_date: untilDate,
      can_send_messages: false
    });
    return true;
  } catch (error) {
    console.error('Erro ao restringir usuário:', error);
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

async function logLinkDetection(groupId, groupTitle, fromInfo, text) {
  try {
    await db.collection('link_detections').add({
      groupId: String(groupId),
      groupTitle: groupTitle || '',
      userId: fromInfo.id,
      userName: fromInfo.username || fromInfo.first_name,
      text,
      detectedAt: new Date()
    });
  } catch (error) {
    console.error('Erro ao registar deteção de link:', error);
  }
}

// ---------- Mensagens privadas (private_messages) ----------
// Campos principais de cada documento:
//   userId, userName, username, firstName, lastName, text, timestamp
//   adminViewed / responded     -> estado no painel
//   adminMessageId              -> 1.ª mensagem enviada ao admin (legado)
//   adminMessageIds[]           -> todas as mensagens enviadas ao admin sobre esta conversa
//   aiStatus                    -> 'pending' | 'answered' | 'failed' | 'skipped' | 'disabled'
//   aiAnswer, aiOriginalAnswer  -> texto atual / original da resposta da IA
//   aiMessageId                 -> message_id da resposta da IA no chat do utilizador
//   aiEdited, aiDeleted, aiError
//   adminReplies[]              -> respostas do admin: { messageId, text, at, edited, deleted }

async function logPrivateMessage(fromInfo, text, userMessageId) {
  try {
    const docRef = await db.collection('private_messages').add({
      userId: fromInfo.id,
      userName: fromInfo.username || fromInfo.first_name,
      username: fromInfo.username || null,
      firstName: fromInfo.first_name || null,
      lastName: fromInfo.last_name || null,
      text,
      userMessageId,
      timestamp: new Date(),
      adminViewed: false,
      responded: false,
      aiStatus: AI_ENABLED ? 'pending' : 'disabled',
      answeredByAI: false,
      adminReplies: []
    });
    return docRef.id;
  } catch (error) {
    console.error('Erro ao registrar mensagem privada:', error);
    return null;
  }
}

async function updatePrivateMessage(docId, patch) {
  if (!docId) return;
  try {
    await db.collection('private_messages').doc(docId).update(patch);
  } catch (error) {
    console.error('Erro ao atualizar mensagem privada:', error.message);
  }
}

async function readPrivateMessage(docId) {
  if (!docId) return null;
  try {
    const snap = await db.collection('private_messages').doc(docId).get();
    return snap.exists ? { id: snap.id, ...snap.data() } : null;
  } catch (error) {
    console.error('Erro ao ler mensagem privada:', error.message);
    return null;
  }
}

// Liga uma mensagem enviada ao admin à conversa (para o admin poder responder com "reply").
async function linkPrivateMessageToAdminMessage(docId, adminMessageId, primary = false) {
  if (!docId || !adminMessageId) return;
  const patch = { adminMessageIds: FieldValue.arrayUnion(adminMessageId) };
  if (primary) patch.adminMessageId = adminMessageId;
  await updatePrivateMessage(docId, patch);
}

async function findPrivateMessageByAdminReply(adminMessageId) {
  try {
    const col = db.collection('private_messages');
    let snap = await col.where('adminMessageIds', 'array-contains', adminMessageId).limit(1).get();
    if (snap.empty) {
      snap = await col.where('adminMessageId', '==', adminMessageId).limit(1).get();
    }
    if (snap.empty) return null;
    const doc = snap.docs[0];
    return { id: doc.id, ...doc.data() };
  } catch (error) {
    console.error('Erro ao procurar mensagem original:', error);
    return null;
  }
}

async function markPrivateMessageResponded(docId) {
  await updatePrivateMessage(docId, { responded: true, adminViewed: true, respondedAt: new Date() });
}

// A mensagem fica "respondida" mas NÃO vista pelo admin (adminViewed=false),
// para continuar na lista do painel e o admin poder rever a resposta da IA.
async function markPrivateMessageAnsweredByAI(docId, answer, aiMessageId) {
  await updatePrivateMessage(docId, {
    responded: true,
    answeredByAI: true,
    aiStatus: 'answered',
    aiAnswer: String(answer || ''),
    aiOriginalAnswer: String(answer || ''),
    aiMessageId: aiMessageId || null,
    aiEdited: false,
    aiDeleted: false,
    aiAnsweredAt: new Date()
  });
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

// Publica um trabalho em grupos + utilizadores e marca-o como publicado.
async function publishJob(jobId) {
  const jobRef = db.collection('jobs').doc(jobId);
  const jobDoc = await jobRef.get();
  if (!jobDoc.exists) return null;

  const job = jobDoc.data();
  const text = `💼 *Novo Trabalho Disponível!*\n\n${job.title}\n💰 Valor: ${job.value}\n📝 ${job.description}\n\n${SITE_URL}`;
  const result = await broadcastToAll(text);
  await jobRef.update({ postedToGroups: true });
  return result;
}

// ============================================
// AÇÕES DO PAINEL SOBRE MENSAGENS PRIVADAS
// (usadas pelos endpoints REST e pelos dashboard_commands)
// ============================================

class PanelError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function loadPrivateMessageOrThrow(docId) {
  const ref = db.collection('private_messages').doc(String(docId));
  const snap = await ref.get();
  if (!snap.exists) throw new PanelError(404, 'Mensagem não encontrada.');
  return { ref, data: snap.data() };
}

// Envia uma resposta (texto puro, sem prefixo) ao utilizador e regista-a na conversa,
// guardando o message_id para poder editar/apagar depois.
async function sendAdminReplyToUser(docId, userId, text) {
  const sent = await sendWithTyping(userId, text);
  if (docId) {
    await updatePrivateMessage(docId, {
      adminReplies: FieldValue.arrayUnion({
        messageId: sent.message_id,
        text,
        at: new Date(),
        edited: false,
        deleted: false
      }),
      responded: true,
      adminViewed: true,
      respondedAt: new Date()
    });
  }
  return sent;
}

async function editBotMessage(chatId, messageId, text) {
  try {
    await bot.editMessageText(text, { chat_id: chatId, message_id: messageId });
  } catch (error) {
    if (/message is not modified/i.test(telegramReason(error))) return; // texto igual ao atual
    throw new PanelError(502, `O Telegram recusou a edição: ${telegramReason(error)}`);
  }
}

async function deleteBotMessage(chatId, messageId) {
  try {
    await bot.deleteMessage(chatId, messageId);
  } catch (error) {
    if (/message to delete not found/i.test(telegramReason(error))) return; // já apagada
    throw new PanelError(
      502,
      `O Telegram recusou apagar (mensagens com mais de 48h ou já removidas não podem ser apagadas): ${telegramReason(error)}`
    );
  }
}

// Editar a resposta que a IA deu ao utilizador (edita a mensagem no chat dele)
async function editAiMessage(docId, text) {
  const newText = String(text || '').trim();
  if (!newText) throw new PanelError(400, 'text é obrigatório.');
  const { ref, data } = await loadPrivateMessageOrThrow(docId);
  if (!data.aiMessageId || data.aiDeleted) {
    throw new PanelError(400, 'Não existe resposta da IA ativa para editar nesta conversa.');
  }
  await editBotMessage(data.userId, data.aiMessageId, newText);
  await ref.update({
    aiAnswer: newText,
    aiOriginalAnswer: data.aiOriginalAnswer || data.aiAnswer || null,
    aiEdited: true,
    aiEditedAt: new Date()
  });
}

// Eliminar a resposta da IA (apaga a mensagem no chat do utilizador)
async function deleteAiMessage(docId) {
  const { ref, data } = await loadPrivateMessageOrThrow(docId);
  if (!data.aiMessageId || data.aiDeleted) {
    throw new PanelError(400, 'Não existe resposta da IA ativa para apagar nesta conversa.');
  }
  await deleteBotMessage(data.userId, data.aiMessageId);
  await ref.update({ aiDeleted: true, aiDeletedAt: new Date() });
}

// Enviar uma resposta do admin (2.ª resposta, ou a 1.ª se a IA falhou)
async function replyToPrivateMessage(docId, text) {
  const t = String(text || '').trim();
  if (!t) throw new PanelError(400, 'text é obrigatório.');
  const { data } = await loadPrivateMessageOrThrow(docId);
  try {
    const sent = await sendAdminReplyToUser(docId, data.userId, t);
    return { messageId: sent.message_id };
  } catch (error) {
    throw new PanelError(502, `Não foi possível entregar a resposta: ${telegramReason(error)}`);
  }
}

async function findAdminReplyIndex(data, messageId) {
  const replies = Array.isArray(data.adminReplies) ? data.adminReplies : [];
  const index = replies.findIndex((r) => Number(r.messageId) === Number(messageId));
  if (index === -1) throw new PanelError(404, 'Resposta do admin não encontrada nesta conversa.');
  return { replies, index };
}

async function editAdminReply(docId, messageId, text) {
  const newText = String(text || '').trim();
  if (!newText) throw new PanelError(400, 'text é obrigatório.');
  const { ref, data } = await loadPrivateMessageOrThrow(docId);
  const { replies, index } = await findAdminReplyIndex(data, messageId);
  await editBotMessage(data.userId, replies[index].messageId, newText);
  replies[index] = { ...replies[index], text: newText, edited: true, editedAt: new Date() };
  await ref.update({ adminReplies: replies });
}

async function deleteAdminReply(docId, messageId) {
  const { ref, data } = await loadPrivateMessageOrThrow(docId);
  const { replies, index } = await findAdminReplyIndex(data, messageId);
  await deleteBotMessage(data.userId, replies[index].messageId);
  replies[index] = { ...replies[index], deleted: true, deletedAt: new Date() };
  await ref.update({ adminReplies: replies });
}

// ============================================
// SERVIDOR HTTP (Express) — painel admin
// ============================================

const PORT = process.env.PORT || 3000;

// Se ADMIN_PANEL_TOKEN estiver definido, o painel tem de enviá-lo no header "x-admin-token".
const PANEL_TOKEN = process.env.ADMIN_PANEL_TOKEN;

function requirePanelToken(req, res, next) {
  if (!PANEL_TOKEN || req.headers['x-admin-token'] === PANEL_TOKEN) return next();
  return res.status(401).json({ error: 'Não autorizado' });
}

// Resposta de erro para as rotas: erros PanelError mostram a mensagem real, os outros uma genérica.
function sendPanelError(res, label, error, fallbackMessage) {
  console.error(`${label}:`, error.message);
  if (error instanceof PanelError) {
    return res.status(error.status).json({ error: error.message });
  }
  return res.status(500).json({ error: fallbackMessage });
}

const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(morgan('tiny'));
app.use(express.json());
app.use('/admin', express.static(path.join(__dirname, 'public/admin')));

if (USE_WEBHOOK) {
  app.post(WEBHOOK_PATH, (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
  });
}

app.post('/api/typing', requirePanelToken, async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId em falta' });
    await bot.sendChatAction(userId, 'typing');
    res.json({ ok: true });
  } catch (error) {
    console.error('Erro ao enviar indicador de digitação:', error.message);
    res.status(500).json({ error: 'Erro ao processar pedido' });
  }
});

// Responder a um utilizador (texto puro, sem prefixo). Se vier docId, a resposta fica
// registada na conversa (e pode ser editada/apagada depois pelo painel).
app.post('/api/reply', requirePanelToken, async (req, res) => {
  try {
    const { userId, text, docId } = req.body;
    if (!userId || !text) return res.status(400).json({ error: 'userId e text são obrigatórios' });

    const sent = await sendAdminReplyToUser(docId || null, userId, text);
    res.json({ ok: true, messageId: sent.message_id });
  } catch (error) {
    console.error('Erro ao enviar resposta pelo painel:', error.message);
    res.status(500).json({ error: 'Erro ao processar pedido: ' + error.message });
  }
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const expectedUser = process.env.ADMIN_PANEL_USER;
  const expectedPass = process.env.ADMIN_PANEL_PASS;

  if (!expectedUser || !expectedPass) {
    return res.status(500).json({
      error: 'Login do painel não configurado. Define ADMIN_PANEL_USER e ADMIN_PANEL_PASS nas variáveis de ambiente.'
    });
  }
  if (username === expectedUser && password === expectedPass) {
    return res.json({ token: PANEL_TOKEN || '' });
  }
  return res.status(401).json({ error: 'Utilizador ou palavra-passe incorretos.' });
});

app.get('/api/stats', requirePanelToken, async (req, res) => {
  try {
    const [groupsSnap, usersSnap, jobsSnap, bansSnap, messagesSnap, keywordsSnap] = await Promise.all([
      db.collection('groups').where('active', '==', true).get(),
      db.collection('users').where('active', '==', true).get(),
      db.collection('jobs').get(),
      db.collection('bans').get(),
      db.collection('private_messages').get(),
      db.collection('keywords').get()
    ]);
    res.json({
      stats: {
        groups: groupsSnap.size,
        users: usersSnap.size,
        jobs: jobsSnap.size,
        bans: bansSnap.size,
        messages: messagesSnap.size,
        keywords: keywordsSnap.size
      }
    });
  } catch (error) {
    console.error('Erro ao obter estatísticas (painel):', error.message);
    res.status(500).json({ error: 'Erro ao obter estatísticas.' });
  }
});

// ---------- Trabalhos ----------
app.get('/api/jobs', requirePanelToken, async (req, res) => {
  try {
    const snap = await db.collection('jobs').where('postedToGroups', '==', false).get();
    const jobs = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    res.json({ jobs });
  } catch (error) {
    console.error('Erro ao listar trabalhos (painel):', error.message);
    res.status(500).json({ error: 'Erro ao listar trabalhos.' });
  }
});

app.post('/api/jobs', requirePanelToken, async (req, res) => {
  try {
    const { title, value, description } = req.body || {};
    if (!title) return res.status(400).json({ error: 'title é obrigatório.' });
    await saveJobPosting({ title, value: value || '', description: description || '' });
    res.json({ ok: true });
  } catch (error) {
    console.error('Erro ao criar trabalho (painel):', error.message);
    res.status(500).json({ error: 'Erro ao criar trabalho.' });
  }
});

app.post('/api/jobs/:id/post', requirePanelToken, async (req, res) => {
  try {
    const result = await publishJob(req.params.id);
    if (!result) return res.status(404).json({ error: 'Trabalho não encontrado.' });
    res.json({ ok: true, result });
  } catch (error) {
    console.error('Erro ao publicar trabalho (painel):', error.message);
    res.status(500).json({ error: 'Erro ao publicar trabalho.' });
  }
});

// ---------- Mensagens privadas + IA ----------

// Por omissão devolve as ainda não vistas pelo admin. ?all=1 devolve as 50 mais recentes.
app.get('/api/messages', requirePanelToken, async (req, res) => {
  try {
    const all = req.query.all === '1' || req.query.all === 'true';
    let query = db.collection('private_messages');
    if (!all) query = query.where('adminViewed', '==', false);
    const snap = await query.orderBy('timestamp', 'desc').limit(all ? 50 : 20).get();
    const messages = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    res.json({ messages });
  } catch (error) {
    console.error('Erro ao listar mensagens (painel):', error.message);
    res.status(500).json({ error: 'Erro ao listar mensagens.' });
  }
});

app.get('/api/messages/:id', requirePanelToken, async (req, res) => {
  try {
    const { data } = await loadPrivateMessageOrThrow(req.params.id);
    res.json({ message: { id: req.params.id, ...data } });
  } catch (error) {
    sendPanelError(res, 'Erro ao obter mensagem (painel)', error, 'Erro ao obter mensagem.');
  }
});

// Dar a conversa como vista (sai da lista de "por ver")
app.post('/api/messages/:id/seen', requirePanelToken, async (req, res) => {
  try {
    const { ref } = await loadPrivateMessageOrThrow(req.params.id);
    await ref.update({ adminViewed: true });
    res.json({ ok: true });
  } catch (error) {
    sendPanelError(res, 'Erro ao marcar mensagem como vista (painel)', error, 'Erro ao atualizar mensagem.');
  }
});

// Enviar uma resposta do admin ao utilizador (2.ª resposta, ou a 1.ª se a IA falhou)
app.post('/api/messages/:id/reply', requirePanelToken, async (req, res) => {
  try {
    const result = await replyToPrivateMessage(req.params.id, (req.body || {}).text);
    res.json({ ok: true, ...result });
  } catch (error) {
    sendPanelError(res, 'Erro ao responder (painel)', error, 'Erro ao enviar resposta.');
  }
});

// Editar a resposta que a IA deu (edita a mensagem no chat do utilizador)
app.post('/api/messages/:id/ai/edit', requirePanelToken, async (req, res) => {
  try {
    await editAiMessage(req.params.id, (req.body || {}).text);
    res.json({ ok: true });
  } catch (error) {
    sendPanelError(res, 'Erro ao editar resposta da IA (painel)', error, 'Erro ao editar resposta da IA.');
  }
});

// Eliminar a resposta que a IA deu (apaga a mensagem no chat do utilizador)
app.post('/api/messages/:id/ai/delete', requirePanelToken, async (req, res) => {
  try {
    await deleteAiMessage(req.params.id);
    res.json({ ok: true });
  } catch (error) {
    sendPanelError(res, 'Erro ao apagar resposta da IA (painel)', error, 'Erro ao apagar resposta da IA.');
  }
});

// Editar / apagar uma resposta que o próprio admin enviou (messageId = adminReplies[].messageId)
app.put('/api/messages/:id/reply/:messageId', requirePanelToken, async (req, res) => {
  try {
    await editAdminReply(req.params.id, req.params.messageId, (req.body || {}).text);
    res.json({ ok: true });
  } catch (error) {
    sendPanelError(res, 'Erro ao editar resposta do admin (painel)', error, 'Erro ao editar resposta.');
  }
});

app.delete('/api/messages/:id/reply/:messageId', requirePanelToken, async (req, res) => {
  try {
    await deleteAdminReply(req.params.id, req.params.messageId);
    res.json({ ok: true });
  } catch (error) {
    sendPanelError(res, 'Erro ao apagar resposta do admin (painel)', error, 'Erro ao apagar resposta.');
  }
});

// Estado da configuração da IA (sem expor a URL completa nem o token)
app.get('/api/ai/status', requirePanelToken, (req, res) => {
  let host = null;
  try {
    host = AI_URL ? new URL(AI_URL).host : null;
  } catch (error) {
    host = 'URL definida';
  }
  res.json({
    ai: { enabled: AI_ENABLED, host, format: AI_FORMAT, timeoutMs: AI_TIMEOUT_MS, hasToken: !!AI_TOKEN }
  });
});

// ---------- Anúncios ----------
app.get('/api/ads', requirePanelToken, async (req, res) => {
  try {
    const ads = await getAdsSettings();
    res.json({ ads });
  } catch (error) {
    console.error('Erro ao obter anúncios (painel):', error.message);
    res.status(500).json({ error: 'Erro ao obter anúncios.' });
  }
});

app.post('/api/ads', requirePanelToken, async (req, res) => {
  try {
    const { ads } = req.body || {};
    if (!Array.isArray(ads) || ads.length === 0) {
      return res.status(400).json({ error: 'ads deve ser uma lista não vazia.' });
    }
    await db.collection('settings').doc('ads').set({ ads, updatedAt: new Date() });
    res.json({ ok: true });
  } catch (error) {
    console.error('Erro ao guardar anúncios (painel):', error.message);
    res.status(500).json({ error: 'Erro ao guardar anúncios.' });
  }
});

app.post('/api/broadcast', requirePanelToken, async (req, res) => {
  try {
    const { text } = req.body || {};
    if (!text) return res.status(400).json({ error: 'text é obrigatório.' });
    const result = await broadcastToAll(text);
    res.json({ ok: true, result });
  } catch (error) {
    console.error('Erro ao enviar broadcast (painel):', error.message);
    res.status(500).json({ error: 'Erro ao enviar broadcast.' });
  }
});

// ---------- Banimentos ----------
app.get('/api/banned', requirePanelToken, async (req, res) => {
  try {
    const snap = await db.collection('bans').limit(50).get();
    const banned = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    res.json({ banned });
  } catch (error) {
    console.error('Erro ao listar banidos (painel):', error.message);
    res.status(500).json({ error: 'Erro ao listar banidos.' });
  }
});

app.post('/api/unban', requirePanelToken, async (req, res) => {
  try {
    const { groupId, userId } = req.body || {};
    if (!groupId || !userId) return res.status(400).json({ error: 'groupId e userId são obrigatórios.' });
    await db.collection('bans').doc(`${groupId}_${userId}`).delete();
    await bot.unbanChatMember(groupId, userId, { only_if_banned: true }).catch(() => {});
    res.json({ ok: true });
  } catch (error) {
    console.error('Erro ao remover banimento (painel):', error.message);
    res.status(500).json({ error: 'Erro ao remover banimento.' });
  }
});

// ---------- Palavras-chave ----------
app.get('/api/keywords', requirePanelToken, async (req, res) => {
  try {
    const snap = await db.collection('keywords').get();
    const keywords = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    res.json({ keywords });
  } catch (error) {
    console.error('Erro ao listar palavras-chave (painel):', error.message);
    res.status(500).json({ error: 'Erro ao listar palavras-chave.' });
  }
});

app.post('/api/keywords', requirePanelToken, async (req, res) => {
  try {
    const { pattern, response, matchType, active } = req.body || {};
    if (!pattern || !response) {
      return res.status(400).json({ error: 'pattern e response são obrigatórios.' });
    }
    const docRef = await db.collection('keywords').add({
      pattern: String(pattern).trim(),
      response: String(response).trim(),
      matchType: matchType || 'contains',
      active: active !== false,
      createdAt: new Date()
    });
    res.json({ ok: true, id: docRef.id });
  } catch (error) {
    console.error('Erro ao criar palavra-chave (painel):', error.message);
    res.status(500).json({ error: 'Erro ao criar palavra-chave.' });
  }
});

app.put('/api/keywords/:id', requirePanelToken, async (req, res) => {
  try {
    const { pattern, response, matchType, active } = req.body || {};
    const patch = { updatedAt: new Date() };
    if (pattern !== undefined) patch.pattern = String(pattern).trim();
    if (response !== undefined) patch.response = String(response).trim();
    if (matchType !== undefined) patch.matchType = matchType;
    if (active !== undefined) patch.active = !!active;
    await db.collection('keywords').doc(req.params.id).set(patch, { merge: true });
    res.json({ ok: true });
  } catch (error) {
    console.error('Erro ao atualizar palavra-chave (painel):', error.message);
    res.status(500).json({ error: 'Erro ao atualizar palavra-chave.' });
  }
});

app.delete('/api/keywords/:id', requirePanelToken, async (req, res) => {
  try {
    await db.collection('keywords').doc(req.params.id).delete();
    res.json({ ok: true });
  } catch (error) {
    console.error('Erro ao apagar palavra-chave (painel):', error.message);
    res.status(500).json({ error: 'Erro ao apagar palavra-chave.' });
  }
});

// ---------- Grupos ----------
app.get('/api/groups', requirePanelToken, async (req, res) => {
  try {
    const snap = await db.collection('groups').where('active', '==', true).get();
    const groups = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    res.json({ groups });
  } catch (error) {
    console.error('Erro ao listar grupos (painel):', error.message);
    res.status(500).json({ error: 'Erro ao listar grupos.' });
  }
});

app.post('/api/groups/:chatId/message', requirePanelToken, async (req, res) => {
  try {
    const { chatId } = req.params;
    const { message } = req.body || {};
    if (!message) return res.status(400).json({ error: 'message é obrigatório.' });
    await sendWithTyping(chatId, message, { parse_mode: 'Markdown' });
    res.json({ ok: true });
  } catch (error) {
    console.error('Erro ao enviar mensagem para grupo (painel):', error.message);
    res.status(500).json({ error: 'Erro ao enviar mensagem para o grupo: ' + error.message });
  }
});

app.post('/api/groups/broadcast', requirePanelToken, async (req, res) => {
  try {
    const { message } = req.body || {};
    if (!message) return res.status(400).json({ error: 'message é obrigatório.' });
    const result = await broadcastToGroupsOnly(message);
    res.json({ ok: true, result });
  } catch (error) {
    console.error('Erro ao enviar broadcast para grupos (painel):', error.message);
    res.status(500).json({ error: 'Erro ao enviar broadcast para grupos.' });
  }
});

app.post('/api/groups/reconcile', requirePanelToken, async (req, res) => {
  try {
    const result = await reconcileGroups();
    res.json({ ok: true, result });
  } catch (error) {
    console.error('Erro ao reconciliar grupos (painel):', error.message);
    res.status(500).json({ error: 'Erro ao reconciliar grupos.' });
  }
});

// ---------- Utilizadores ----------
app.get('/api/users', requirePanelToken, async (req, res) => {
  try {
    const snap = await db.collection('users').where('active', '==', true).get();
    const users = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    res.json({ users });
  } catch (error) {
    console.error('Erro ao listar utilizadores (painel):', error.message);
    res.status(500).json({ error: 'Erro ao listar utilizadores.' });
  }
});

app.post('/api/users/:userId/message', requirePanelToken, async (req, res) => {
  try {
    const { userId } = req.params;
    const { message } = req.body || {};
    if (!message) return res.status(400).json({ error: 'message é obrigatório.' });
    await sendWithTyping(userId, message, { parse_mode: 'Markdown' });
    res.json({ ok: true });
  } catch (error) {
    console.error('Erro ao enviar mensagem para utilizador (painel):', error.message);
    res.status(500).json({ error: 'Erro ao enviar mensagem para o utilizador: ' + error.message });
  }
});

app.post('/api/users/broadcast', requirePanelToken, async (req, res) => {
  try {
    const { message } = req.body || {};
    if (!message) return res.status(400).json({ error: 'message é obrigatório.' });
    const result = await broadcastToUsersOnly(message);
    res.json({ ok: true, result });
  } catch (error) {
    console.error('Erro ao enviar broadcast para utilizadores (painel):', error.message);
    res.status(500).json({ error: 'Erro ao enviar broadcast para utilizadores.' });
  }
});

app.get('/', (req, res) => {
  res.type('text/plain').send('Kanda Freelancer Bot está ativo ✅');
});

app.listen(PORT, () => {
  console.log(`🌐 Servidor HTTP (Express) a escutar na porta ${PORT}`);
});

// ============================================
// IA: COMUNICAÇÃO COM O SPACE DO MODELO
// ============================================

// Aceita os formatos mais comuns de resposta:
//   { answer | response | reply | text | generated_text | output | message: "..." }
//   [ { generated_text: "..." } ]   { data: [ "..." ] } (Gradio)   "texto simples"
function extractAIText(data) {
  if (typeof data === 'string') return data;
  if (Array.isArray(data)) return extractAIText(data[0]);
  if (data && typeof data === 'object') {
    for (const key of ['answer', 'response', 'reply', 'text', 'generated_text', 'output', 'message']) {
      if (typeof data[key] === 'string') return data[key];
    }
    if (Array.isArray(data.data)) return extractAIText(data.data[0]);
  }
  return null;
}

async function callAIOnce(fromInfo, text, newTopic = false) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);

  try {
    const headers = { 'Content-Type': 'application/json' };
    if (AI_TOKEN) headers.Authorization = `Bearer ${AI_TOKEN}`;

    const payload =
      AI_FORMAT === 'gradio'
        ? { data: [text] }
        : {
            user_id: String(fromInfo.id), // o main.py exige STRING
            message: text,
            channel: 'telegram',
            new_topic: newTopic,
            user_name: fromInfo.username || fromInfo.first_name || null
          };

    const res = await fetch(AI_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    if (!res.ok) throw new Error(`Space respondeu HTTP ${res.status}`);

    const raw = await res.text();
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      parsed = raw;
    }

    const answer = extractAIText(parsed);
    if (!answer || !answer.trim()) throw new Error('Resposta do Space vazia ou em formato desconhecido');
    return answer.trim();
  } finally {
    clearTimeout(timer);
  }
}

// Pergunta ao modelo (2 tentativas: o Space pode estar a acordar).
// Devolve { ok: true, answer } ou { ok: false, reason }.
async function askKandaAI(fromInfo, text) {
  if (!AI_ENABLED) return { ok: false, reason: 'IA desligada' };

  const newTopic = AI_RESET_NEXT.delete(fromInfo.id);
  let lastReason = 'erro desconhecido';

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const answer = await callAIOnce(fromInfo, text, newTopic);
      return { ok: true, answer: answer.length > 4000 ? `${answer.slice(0, 3990)}…` : answer };
    } catch (error) {
      lastReason = error.name === 'AbortError' ? `timeout de ${AI_TIMEOUT_MS}ms` : error.message;
      console.error(`⚠️ IA falhou (tentativa ${attempt}/2): ${lastReason}`);
      if (attempt < 2) await new Promise((r) => setTimeout(r, 2000));
    }
  }

  if (newTopic) AI_RESET_NEXT.add(fromInfo.id); // o "assunto novo" ainda não chegou ao modelo
  return { ok: false, reason: lastReason };
}

// Mantém "digitando..." visível enquanto a IA pensa.
function keepTyping(chatId) {
  bot.sendChatAction(chatId, 'typing').catch(() => {});
  const interval = setInterval(() => {
    bot.sendChatAction(chatId, 'typing').catch(() => {});
  }, 4000);
  return () => clearInterval(interval);
}

// Executa tarefas de um mesmo utilizador uma a uma, por ordem de chegada.
function runSerial(key, task) {
  const previous = AI_CHAINS.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(task);
  AI_CHAINS.set(key, current);
  const cleanup = () => {
    if (AI_CHAINS.get(key) === current) AI_CHAINS.delete(key);
  };
  current.then(cleanup, cleanup);
  return current;
}

// ---------- Notificações ao admin (texto simples, sem Markdown) ----------

async function sendToAdmin(text, options = {}) {
  try {
    const safeText = text.length > 4000 ? `${text.slice(0, 3990)}…` : text;
    return await bot.sendMessage(adminId, safeText, options);
  } catch (error) {
    console.error('Erro ao notificar o admin:', error.message);
    return null;
  }
}

// Envia um aviso ao admin (como resposta à mensagem original) e liga-o à conversa,
// para o admin poder responder ao utilizador com "reply" também a este aviso.
async function noticeAdmin(docId, replyToMessageId, text) {
  const options = replyToMessageId
    ? { reply_to_message_id: replyToMessageId, allow_sending_without_reply: true }
    : {};
  let sent = await sendToAdmin(text, options);
  if (!sent && replyToMessageId) sent = await sendToAdmin(text);
  if (sent) await linkPrivateMessageToAdminMessage(docId, sent.message_id, false);
  return sent;
}

const ACK_NO_AI = '✅ Sua mensagem foi recebida! O administrador responderá em breve.';
const ACK_AI_DOWN =
  '✅ Sua mensagem foi recebida! O assistente está indisponível agora, mas o administrador responderá em breve.';

// Fluxo completo de uma mensagem privada de um utilizador:
//  1. o admin é notificado logo (quem escreveu + o texto);
//  2. a IA responde ao utilizador;
//  3. o admin recebe a resposta da IA — ou o aviso de que a IA NÃO respondeu.
async function handleUserPrivateMessage(msg, text) {
  const chatId = msg.chat.id;
  const from = msg.from;
  const docId = await logPrivateMessage(from, text, msg.message_id);
  const label = describeUser(from);
  const shownText = text.length > 3000 ? `${text.slice(0, 3000)}…` : text;

  // 1) Notificação imediata ao admin
  const statusLine = AI_ENABLED
    ? '🤖 A IA vai responder. Vais ver aqui a resposta dela a seguir (ou um aviso se ela falhar).'
    : '⚠️ IA desligada — responde tu.';
  const forwarded = await sendToAdmin(
    `📨 Mensagem Privada\n\nDe: ${label}\n\n"${shownText}"\n\n${statusLine}\n\nResponda a ESTA mensagem para falar diretamente com o utilizador.`
  );
  if (forwarded) await linkPrivateMessageToAdminMessage(docId, forwarded.message_id, true);
  const forwardedId = forwarded ? forwarded.message_id : null;

  // IA desligada: fluxo clássico (admin responde à mão)
  if (!AI_ENABLED) {
    await sendWithTyping(chatId, ACK_NO_AI).catch((error) => {
      console.error(`Não foi possível confirmar receção ao utilizador ${chatId}:`, error.message);
    });
    return;
  }

  // Muitas mensagens seguidas à espera da IA: não empilha, passa para o admin
  const pending = AI_PENDING.get(from.id) || 0;
  if (pending >= AI_MAX_QUEUE) {
    await updatePrivateMessage(docId, { aiStatus: 'skipped', aiError: 'muitas mensagens seguidas' });
    await noticeAdmin(
      docId,
      forwardedId,
      `⚠️ A IA não vai responder a esta mensagem de ${label}: há ${pending} mensagens dele à espera. Responde tu, se for preciso.`
    );
    await sendWithTyping(chatId, '⏳ Ainda estou a responder às tuas mensagens anteriores. Só um instante!').catch(() => {});
    return;
  }

  // 2) IA responde
  AI_PENDING.set(from.id, pending + 1);
  try {
    await runSerial(from.id, () => answerWithAI(msg, text, docId, forwardedId, label));
  } finally {
    const left = (AI_PENDING.get(from.id) || 1) - 1;
    if (left <= 0) AI_PENDING.delete(from.id);
    else AI_PENDING.set(from.id, left);
  }
}

async function answerWithAI(msg, text, docId, forwardedId, label) {
  const chatId = msg.chat.id;

  const stopTyping = keepTyping(chatId);
  let result;
  try {
    result = await askKandaAI(msg.from, text);
  } finally {
    stopTyping();
  }

  // IA não respondeu -> o admin é avisado e o utilizador fica a saber que vem um humano
  if (!result.ok) {
    await updatePrivateMessage(docId, { aiStatus: 'failed', aiError: result.reason });
    await noticeAdmin(
      docId,
      forwardedId,
      `⚠️ A IA NÃO respondeu a ${label}.\nMotivo: ${result.reason}\n\nO utilizador está à espera. Responde a ESTA mensagem (ou à original) para o atender, ou usa o painel.`
    );
    await sendWithTyping(chatId, ACK_AI_DOWN).catch((error) => {
      console.error(`Não foi possível avisar o utilizador ${chatId}:`, error.message);
    });
    return;
  }

  // Se o admin já respondeu enquanto a IA pensava, não mandamos uma resposta duplicada
  const fresh = await readPrivateMessage(docId);
  if (fresh && Array.isArray(fresh.adminReplies) && fresh.adminReplies.length > 0) {
    await updatePrivateMessage(docId, { aiStatus: 'skipped', aiAnswer: result.answer, aiError: 'admin já respondeu' });
    await noticeAdmin(
      docId,
      forwardedId,
      `ℹ️ A IA gerou uma resposta para ${label}, mas como já respondeste NÃO a enviei ao utilizador.\n\nResposta da IA (não enviada):\n\n${result.answer}`
    );
    return;
  }

  // Enviar a resposta da IA ao utilizador (texto simples: a saída de um modelo pode ter "*" ou "_" soltos)
  let sent;
  try {
    sent = await sendWithTyping(chatId, result.answer);
  } catch (error) {
    await updatePrivateMessage(docId, { aiStatus: 'failed', aiAnswer: result.answer, aiError: telegramReason(error) });
    await noticeAdmin(
      docId,
      forwardedId,
      `⚠️ A IA respondeu a ${label}, mas não consegui entregar a mensagem (${telegramReason(error)}).\n\nResposta da IA:\n\n${result.answer}`
    );
    return;
  }

  await markPrivateMessageAnsweredByAI(docId, result.answer, sent.message_id);

  // 3) O admin vê exatamente o que a IA disse ao utilizador
  await noticeAdmin(
    docId,
    forwardedId,
    `🤖 Resposta da IA a ${label}:\n\n${result.answer}\n\n✏️ Para enviar uma 2.ª resposta, responde a ESTA mensagem. Para editar ou apagar a resposta da IA, usa o painel.`
  );
}

// ============================================
// TECLADOS
// ============================================

function mainMenuKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '📋 Como Funciona', callback_data: 'como_funciona' },
          { text: '🌐 Criar Conta', url: SITE_URL }
        ],
        [{ text: '💬 Falar com Admin', url: ADMIN_CONTACT }],
        [{ text: '🔒 Política de Privacidade', callback_data: 'politica_privacidade' }]
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

// Junta "🔙 Voltar ao Menu" a um teclado existente (ou cria um só com esse botão).
function withBackRow(keyboardObj) {
  const existingRows =
    keyboardObj && keyboardObj.reply_markup && Array.isArray(keyboardObj.reply_markup.inline_keyboard)
      ? keyboardObj.reply_markup.inline_keyboard
      : [];

  return {
    reply_markup: {
      inline_keyboard: [...existingRows, [{ text: '🔙 Voltar ao Menu', callback_data: 'go:menu' }]]
    }
  };
}

// ============================================
// TEXTOS
// ============================================

const WELCOME_PRIVATE = `👋 Olá! Bem-vindo(a) à Kanda Freelancer!\n\nSomos a equipa que liga comerciantes a freelancers. 🤝\n\n💼 És freelancer? Fala comigo sobre dúvidas, dificuldades ou como começar.\n🏪 És comerciante? Tens um serviço para publicar? Escreve aqui os detalhes e eu envio ao administrador.\n\n✍️ Podes escrever à vontade — um simples "oi", "olá", uma dúvida, ou o que precisares. Não precisas de usar comandos, eu vejo e respondo tudo por aqui!\n\n👇 Para mais informações, usa os botões abaixo.`;

const HELP_TEXT = `📚 *Como Funciona a Kanda Freelancer*\n\n
*1. Para Freelancers:*

Na plataforma Kanda Freelancer, qualquer pessoa pode:
✅ Aceitar anúncios publicados por comerciantes
✅ Realizar tarefas online de forma rápida e segura
✅ Entregar provas (captura de ecrã, descrição ou dados solicitados)
✅ Receber o pagamento direto na carteira, após aprovação do comerciante

*Como começar:*
1️⃣ Crie a sua conta na plataforma. Se tiver um código de amigo, pode usá-lo (quem te convidou ganha pontos), mas também pode criar a conta sem nenhum código.
2️⃣ No cadastro, escolha o tipo de conta *Freelancer*.
3️⃣ Assim que criar a conta, submeta a verificação.
4️⃣ Aguarde entre 30 minutos e 1 hora pela aprovação.
5️⃣ Depois disso, volte e clique em "Aceitar anúncio" para começar a trabalhar.

⚠️ Todo o processo é acompanhado pelo administrador do grupo, @zuacassongo, que vai te orientar sobre as boas práticas e normas da plataforma. Fale com ele em caso de dúvidas ou deixa sua duvida aqui.

📢 *Importante: aqui não se investe dinheiro!*
Muita gente pergunta se o Kanda Freelancer é uma plataforma de investimento.
➡️ A resposta é simples: não!

Aqui você realiza tarefas online, recebe uma comissão por cada atividade concluída, tudo isso de forma gratuita, sem precisar colocar dinheiro.
A única coisa que você "investe" aqui é o seu tempo — e nada mais.

🌐 ${SITE_URL}`;

// ⚠️ Texto de exemplo — substitui pelo conteúdo real da tua política de privacidade e termos de uso.
const PRIVACY_TEXT = `🔒 *Política de Privacidade e Termos de Uso*\n\n
*1. Dados que o bot recolhe (Telegram):*
✅ Nome e nome de utilizador do Telegram
✅ Identificador (ID) de utilizador do Telegram
✅ Mensagens enviadas em privado ao bot

📌 O bot usa estes dados apenas para:
- Responder às suas mensagens
- Enviar anúncios da plataforma
- Gerir a segurança nos grupos (avisos e banimentos por links)

🚫 O bot *não recolhe, não acede e não guarda* documentos pessoais, dados de identificação (KYC) ou qualquer informação sensível dos utilizadores.

*2. Sobre as contas de criptomoedas (KYC):*
Na Kanda Freelancer, comerciantes adquirem contas de criptomoedas verificadas (KYC) mediante pagamento.

A plataforma fornece tudo o que os freelancers precisam para realizar as suas atividades diariamente e ganhar dinheiro. Os comerciantes publicam serviços ou trabalhos de diversos tipos, e os freelancers realizam essas tarefas em troca de comissão.

🔐 Os dados usados para criar essas contas ficam guardados exclusivamente no sistema da própria conta — protegidos e encriptados na origem.
🔐 Nem o comerciante, nem o bot, nem a nossa equipa têm acesso aos documentos ou dados pessoais usados na verificação.
🔐 O comerciante apenas utiliza a conta como ferramenta — sem nunca extrair, ver ou copiar os documentos associados a ela.

Isto significa que os seus dados pessoais usados na criação da conta *permanecem protegidos e fora de alcance*, mesmo depois da venda.

*3. Partilha de dados:*
🚫 Não vendemos nem partilhamos os seus dados com terceiros.

*4. Termos de Uso:*
✋ É proibido publicar links não autorizados nos grupos.
✋ Ao usar o bot, concorda com estes termos.

*Dúvidas sobre os seus dados ou sobre como as contas são protegidas?*
👤 Contato: @zuacassongo`;

// ============================================
// COMANDOS DE GRUPO / GERAIS
// ============================================

// Respostas automáticas (regex) NÃO devem disparar:
//  - no chat do admin (ele escreve "?" ao responder a utilizadores);
//  - em privado quando a IA está ativa (é o modelo que responde);
//  - em grupos, quando a mensagem tem link (quem trata é a deteção de links).
function skipCannedReply(msg) {
  if (!msg.from) return true;
  if (isGroupChatType(msg.chat.type)) return containsLink(msg.text || '');
  if (String(msg.chat.id) === String(adminId)) return true;
  return AI_ENABLED;
}

// "/start" (privado) e "/start@NomeDoBot" (grupo)
bot.onText(/^\/start(@\w+)?$/, safeHandler(async (msg) => {
  const chatId = msg.chat.id;

  if (isGroupChatType(msg.chat.type)) {
    await registerGroup(chatId, msg.chat.title);
    const welcomeMsg = `🤖 *Kanda Freelancer Bot Ativado!*\n\n✅ Sistema de proteção contra links ativado\n✅ Anúncios automáticos configurados\n✅ Painel administrativo disponível\n\nPara mais informações, envie mensagens privadas ao bot!`;
    await sendWithTyping(chatId, welcomeMsg, { parse_mode: 'Markdown', ...groupWelcomeKeyboard() });
  } else {
    await registerUser(msg.from);
    AI_RESET_NEXT.add(msg.from.id); // /start = conversa nova para a IA (new_topic)
    await sendWithTyping(chatId, WELCOME_PRIVATE, mainMenuKeyboard());
  }
}));

// /novo (ou /reset, /limpar): começa um assunto novo na IA. Só em chat privado.
bot.onText(/^\/(novo|reset|limpar)(@\w+)?$/i, safeHandler(async (msg) => {
  if (msg.chat.type !== 'private' || !msg.from) return;
  AI_RESET_NEXT.add(msg.from.id);
  await sendWithTyping(msg.chat.id, 'Certo, vamos começar um assunto novo. Como posso ajudar?');
}));

bot.onText(/^\/comofunciona(@\w+)?$/, safeHandler(async (msg) => {
  await sendWithTyping(msg.chat.id, HELP_TEXT, { parse_mode: 'Markdown', ...withBackRow(mainMenuKeyboard()) });
}));

bot.onText(/^\/faladmin(@\w+)?$/, safeHandler(async (msg) => {
  await sendWithTyping(
    msg.chat.id,
    `👤 Para falar diretamente com o administrador, clica aqui: ${ADMIN_CONTACT}`,
    { parse_mode: 'Markdown' }
  );
}));

bot.onText(/\?/, safeHandler(async (msg) => {
  if (skipCannedReply(msg)) return;
  if (isGroupChatType(msg.chat.type) && !QUESTION_HELP_IN_GROUPS) return;
  await sendWithTyping(msg.chat.id, HELP_TEXT, { parse_mode: 'Markdown', ...withBackRow(mainMenuKeyboard()) });
}));

bot.onText(/como funciona|como trabaja|como trabalha/i, safeHandler(async (msg) => {
  if (skipCannedReply(msg)) return;
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

  await sendWithTyping(msg.chat.id, response, { parse_mode: 'Markdown', ...withBackRow(mainMenuKeyboard()) });
}));

bot.onText(/quero trabalhar|preciso de ajuda|tenho dificuldade/i, safeHandler(async (msg) => {
  if (skipCannedReply(msg)) return;
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
}));

// Botões inline
bot.on('callback_query', safeHandler(async (query) => {
  try {
    await bot.answerCallbackQuery(query.id);
  } catch (error) {
    // callback expirado / já respondido — não é crítico
  }

  if (!query.message) return;
  const chatId = query.message.chat.id;

  if (query.data === 'como_funciona') {
    await sendWithTyping(chatId, HELP_TEXT, { parse_mode: 'Markdown', ...withBackRow() });
  }

  if (query.data === 'politica_privacidade') {
    await sendWithTyping(chatId, PRIVACY_TEXT, { parse_mode: 'Markdown', ...withBackRow() });
  }

  if (query.data === 'go:menu') {
    await sendWithTyping(chatId, WELCOME_PRIVATE, mainMenuKeyboard());
  }
}));

// ============================================
// EVENTO: BOT ADICIONADO / REMOVIDO / PROMOVIDO / BLOQUEADO
// ============================================

bot.on('my_chat_member', safeHandler(async (upd) => {
  const type = upd.chat && upd.chat.type;

  if (isGroupChatType(type)) {
    await registerGroupFromChatMember(upd);
    return;
  }

  // Chat privado: se o utilizador bloqueou o bot deixa de receber anúncios; se desbloqueou, volta a receber.
  if (type === 'private') {
    const status = upd.new_chat_member && upd.new_chat_member.status;
    const active = !['left', 'kicked'].includes(status);
    await db
      .collection('users')
      .doc(String(upd.chat.id))
      .update({ active })
      .catch(() => {}); // utilizador nunca registado: ignora
  }
}));

// ============================================
// RELAY: ADMIN RESPONDE (reply) -> UTILIZADOR
// O utilizador recebe SÓ o texto puro, como se fosse o próprio bot.
// Funciona respondendo à mensagem original encaminhada OU ao aviso da resposta da IA.
// ============================================

async function handleAdminChat(msg) {
  const text = msg.text || '';

  if (msg.reply_to_message) {
    const original = await findPrivateMessageByAdminReply(msg.reply_to_message.message_id);
    if (original) {
      const who = original.username
        ? `@${original.username}`
        : original.firstName || original.userName || original.userId;
      try {
        await sendAdminReplyToUser(original.id, original.userId, text);
        await bot.sendMessage(msg.chat.id, `✅ Resposta enviada a ${who}.`);
      } catch (error) {
        await bot.sendMessage(
          msg.chat.id,
          `⚠️ Não foi possível entregar a resposta a ${who} — provavelmente bloqueou o bot ou a conta já não existe. (${telegramReason(error)})`
        ).catch(() => {});
      }
      return true;
    }

    // Respondeu a uma mensagem do bot que não está ligada a nenhuma conversa
    if (botInfo && msg.reply_to_message.from && msg.reply_to_message.from.id === botInfo.id) {
      await bot.sendMessage(
        msg.chat.id,
        '⚠️ Não encontrei a conversa desta mensagem (é antiga ou não é uma notificação de utilizador).'
      ).catch(() => {});
      return true;
    }
  }

  return false;
}

// ============================================
// MENSAGENS GERAIS (PRIVADO, GRUPO, MÍDIA)
// ============================================

bot.on('message', safeHandler(async (msg) => {
  if (!msg.from) return; // posts de canal, etc.

  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const userName = msg.from.username || msg.from.first_name;
  const text = msg.text || '';
  const isGroup = isGroupChatType(msg.chat.type);

  // ---------- CHAT PRIVADO DO PRÓPRIO ADMIN ----------
  if (!isGroup && chatId === ADMIN_ID_NUM) {
    if (text && !text.startsWith('/')) {
      const handled = await handleAdminChat(msg);
      if (handled) return;
    }
    return; // comandos de admin (/admin, /jobs...) são tratados pelos onText próprios
  }

  // ---------- MENSAGENS PRIVADAS DE UTILIZADORES COMUNS ----------
  if (!isGroup) {
    if (msg.chat.type !== 'private') return;

    await registerUser(msg.from);

    if (!text || text.startsWith('/')) return;

    await handleUserPrivateMessage(msg, text);
    return;
  }

  // ============================================
  // ---------- DENTRO DE GRUPOS ----------
  //   0. garante que o grupo está registado/ativo
  //   1. mídia (apaga se o bot for admin; ignora se não for)
  //   2. LINK — avisa SEMPRE (bot admin ou não)
  //   3. PALAVRAS-CHAVE — só se não houver link e houver correspondência
  // ============================================
  await ensureGroupRegistered(msg.chat);

  const isMedia =
    msg.photo || msg.video || msg.animation || msg.document || msg.sticker || msg.video_note || msg.voice;

  if (isMedia) {
    if (await botCanModerate(chatId)) {
      try {
        await bot.deleteMessage(chatId, msg.message_id);
      } catch (error) {
        console.error('Erro ao apagar mídia no grupo:', error.message);
      }
    }
    return;
  }

  if (!text) return;

  // ---------- 1. DETEÇÃO DE LINK ----------
  if (containsLink(text)) {
    await logLinkDetection(chatId, msg.chat.title, msg.from, text);

    const isBanned = await isUserBanned(chatId, userId);
    if (isBanned) return;

    const canModerate = await botCanModerate(chatId);
    const who = displayName(msg.from);

    if (canModerate) {
      try {
        await bot.deleteMessage(chatId, msg.message_id);
      } catch (error) {
        console.error('Erro ao deletar mensagem com link:', error.message);
      }

      const warningCount = await addWarning(chatId, userId, userName);

      if (warningCount >= BAN_THRESHOLD) {
        const banned = await banUser(chatId, userId, userName);
        if (banned) {
          await sendWithTyping(
            chatId,
            `⛔ *Usuário Banido*\n\n${who} foi removido por publicação repetida de links.`,
            { parse_mode: 'Markdown' }
          ).catch(() => {});
        } else if (await botCanRestrict(chatId)) {
          await restrictUser(chatId, userId, 60);
          await sendWithTyping(
            chatId,
            `🔇 ${who} foi restringido por 1 hora após atingir ${BAN_THRESHOLD} avisos por links.`,
            { parse_mode: 'Markdown' }
          ).catch(() => {});
        }
      } else {
        try {
          const warningMsg = await sendWithTyping(
            chatId,
            `⚠️ *Aviso para ${who}*\n\n🚫 Links não são permitidos aqui! Por favor, remove o link publicado.\n\n❌ Sua mensagem foi removida.\n⚠️ Aviso ${warningCount}/${BAN_THRESHOLD}\n\n⛔ Se receber ${BAN_THRESHOLD} avisos, será banido ou restringido!\n\n📌 Envie mensagens privadas ao bot para sugestões.`,
            { parse_mode: 'Markdown' }
          );
          setTimeout(() => {
            bot.deleteMessage(chatId, warningMsg.message_id).catch(() => {});
          }, 30000);
        } catch (error) {
          console.error(`Não foi possível enviar aviso de link no grupo ${chatId}:`, error.message);
        }
      }
    } else {
      // Bot NÃO é admin: não apaga nem bane, mas avisa sempre.
      const warningCount = await addWarning(chatId, userId, userName);
      try {
        const warningMsg = await sendWithTyping(
          chatId,
          `⚠️ ${who}, por favor remove o link que publicaste. Links não são permitidos neste grupo.\n\n⚠️ Aviso ${warningCount}/${BAN_THRESHOLD}`,
          { parse_mode: 'Markdown' }
        );
        setTimeout(() => {
          bot.deleteMessage(chatId, warningMsg.message_id).catch(() => {});
        }, 30000);
      } catch (error) {
        console.error(`Não foi possível enviar aviso de link (sem admin) no grupo ${chatId}:`, error.message);
      }

      if (warningCount >= BAN_THRESHOLD) {
        await sendWithTyping(
          adminId,
          `⚠️ ${who} atingiu ${BAN_THRESHOLD} avisos por links no grupo "${msg.chat.title}", mas o bot não é administrador e não pôde remover/banir.`
        ).catch(() => {});
      }
    }
    return; // link tratado, não verifica palavras-chave na mesma mensagem
  }

  // ---------- 2. PALAVRAS-CHAVE (configuradas no painel) ----------
  const keyword = findKeywordResponse(text);
  if (keyword) {
    await sendWithTyping(chatId, keyword.response, { parse_mode: 'Markdown' }).catch((error) => {
      console.error(`Não foi possível enviar resposta de palavra-chave no grupo ${chatId}:`, error.message);
    });
  }
  // Sem correspondência: o bot não responde nada.
}));

// Fallback: adição do bot a um grupo pode chegar como mensagem de serviço (new_chat_members)
bot.on('message', safeHandler(async (msg) => {
  if (!isGroupChatType(msg.chat.type)) return;
  const newMembers = msg.new_chat_members || [];
  if (botInfo && newMembers.some((m) => m.id === botInfo.id)) {
    await ensureGroupRegistered(msg.chat);
    console.log(`👥 [fallback via new_chat_members] Bot adicionado ao grupo "${msg.chat.title || msg.chat.id}".`);
  }
}));

// ============================================
// COMANDOS ADMINISTRATIVOS (via Telegram)
// ============================================

function isAdmin(chatId) {
  return chatId === ADMIN_ID_NUM;
}

bot.onText(/\/admin/, safeHandler(async (msg) => {
  const chatId = msg.chat.id;
  if (!isAdmin(chatId)) {
    await sendWithTyping(chatId, '❌ Você não tem permissão para usar este comando.');
    return;
  }

  const adminPanel = `
🎛️ *PAINEL ADMINISTRATIVO*\n
/jobs - Ver trabalhos pendentes
/postar_trabalho [ID] - Publicar um trabalho
/messages - Ver mensagens privadas não vistas
/broadcast [texto] - Enviar anúncio a todos os grupos e utilizadores
/stats - Ver estatísticas
/banned - Ver usuários banidos
/unban [groupId] [userId] - Remover banimento
/reconciliar_grupos - Verificar e corrigir grupos "fantasmas"
/ia - Ver estado da IA`;

  await sendWithTyping(chatId, adminPanel, { parse_mode: 'Markdown' });
}));

bot.onText(/\/jobs/, safeHandler(async (msg) => {
  const chatId = msg.chat.id;
  if (!isAdmin(chatId)) return sendWithTyping(chatId, '❌ Acesso negado.');

  try {
    const jobsSnapshot = await db.collection('jobs').where('postedToGroups', '==', false).get();

    if (jobsSnapshot.empty) {
      await sendWithTyping(chatId, '📭 Nenhum trabalho pendente.');
      return;
    }

    let jobsList = '📋 *TRABALHOS PENDENTES*\n\n';
    let i = 0;
    jobsSnapshot.forEach((doc) => {
      i++;
      const job = doc.data();
      jobsList += `${i}. ${job.title}\n`;
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
}));

bot.onText(/\/postar_trabalho\s+(\S+)/, safeHandler(async (msg, match) => {
  const chatId = msg.chat.id;
  if (!isAdmin(chatId)) return sendWithTyping(chatId, '❌ Acesso negado.');

  try {
    await sendWithTyping(chatId, '📤 A publicar o trabalho...');
    const result = await publishJob(match[1]);
    if (!result) {
      await bot.sendMessage(chatId, '❌ Trabalho não encontrado.');
      return;
    }
    await bot.sendMessage(
      chatId,
      `✅ Trabalho publicado!\n📤 Grupos: ${result.groupsSent}/${result.groupsTotal}\n📤 Utilizadores: ${result.usersSent}/${result.usersTotal}`
    );
  } catch (error) {
    console.error('Erro ao publicar trabalho:', error);
    await sendWithTyping(chatId, '❌ Erro ao publicar trabalho.');
  }
}));

bot.onText(/\/messages/, safeHandler(async (msg) => {
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
      await sendWithTyping(chatId, '📭 Nenhuma mensagem privada por ver.');
      return;
    }

    let messagesList = '💬 *MENSAGENS PRIVADAS*\n\n';
    let i = 0;
    messagesSnapshot.forEach((doc) => {
      i++;
      const data = doc.data();
      const who = data.username ? `@${data.username}` : data.firstName || data.userName;
      let state = '';
      if (data.aiStatus === 'answered') state = ' 🤖 respondida pela IA';
      else if (data.aiStatus === 'failed') state = ' ⚠️ IA falhou';
      else if (data.aiStatus === 'pending') state = ' ⏳ IA a responder';
      messagesList += `${i}. ${who} (${data.userId})${state}\n`;
      messagesList += `   "${data.text}"\n`;
      if (data.aiAnswer) {
        const shown = String(data.aiAnswer);
        messagesList += `   ↳ IA: "${shown.substring(0, 150)}${shown.length > 150 ? '…' : ''}"\n`;
      }
      messagesList += '\n';
    });
    messagesList += 'ℹ️ Para responder, vá à notificação do utilizador e clique em "Responder". Para editar/apagar a resposta da IA, use o painel.';

    await sendWithTyping(chatId, messagesList, { parse_mode: 'Markdown' });
  } catch (error) {
    console.error('Erro ao listar mensagens:', error);
    await sendWithTyping(chatId, '❌ Erro ao listar mensagens.');
  }
}));

bot.onText(/\/stats/, safeHandler(async (msg) => {
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
💬 Mensagens: ${messagesSnapshot.size}
🔑 Palavras-chave ativas: ${KEYWORDS_CACHE.filter((k) => k.active !== false).length}`;

    await sendWithTyping(chatId, stats, { parse_mode: 'Markdown' });
  } catch (error) {
    console.error('Erro ao obter estatísticas:', error);
    await sendWithTyping(chatId, '❌ Erro ao obter estatísticas.');
  }
}));

bot.onText(/\/banned/, safeHandler(async (msg) => {
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
}));

bot.onText(/\/unban (-?\d+) (\d+)/, safeHandler(async (msg, match) => {
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
}));

bot.onText(/\/broadcast ([\s\S]+)/, safeHandler(async (msg, match) => {
  const chatId = msg.chat.id;
  if (!isAdmin(chatId)) return sendWithTyping(chatId, '❌ Acesso negado.');

  const text = match[1];
  await sendWithTyping(chatId, '📤 A enviar anúncio a todos os grupos e utilizadores...');

  const result = await broadcastToAll(text);

  await bot.sendMessage(
    chatId,
    `✅ Anúncio enviado!\n📤 Grupos: ${result.groupsSent}/${result.groupsTotal}\n📤 Utilizadores: ${result.usersSent}/${result.usersTotal}`
  );
}));

bot.onText(/\/(reconciliar_grupos|reconcile)\b/, safeHandler(async (msg) => {
  const chatId = msg.chat.id;
  if (!isAdmin(chatId)) return sendWithTyping(chatId, '❌ Acesso negado.');

  await sendWithTyping(chatId, '🔍 A verificar todos os grupos junto do Telegram...');
  const result = await reconcileGroups();
  await sendWithTyping(
    chatId,
    `✅ Reconciliação concluída.\n🔎 Verificados: ${result.checked}\n🔧 Corrigidos: ${result.fixed}`
  );
}));

// Estado da IA (sem expor a URL completa)
bot.onText(/^\/ia(@\w+)?$/, safeHandler(async (msg) => {
  const chatId = msg.chat.id;
  if (!isAdmin(chatId)) return sendWithTyping(chatId, '❌ Acesso negado.');

  if (!AI_ENABLED) {
    await bot.sendMessage(chatId, '🤖 IA desligada: defina KANDA_AI_URL para ativar. Mensagens privadas seguem só para si.');
    return;
  }

  let host = 'URL definida';
  try {
    host = new URL(AI_URL).host;
  } catch (e) {
    // mantém o texto genérico
  }
  await bot.sendMessage(
    chatId,
    `🤖 IA ativa\nHost: ${host}\nFormato: ${AI_FORMAT}\nTimeout: ${AI_TIMEOUT_MS}ms\nFila máx. por utilizador: ${AI_MAX_QUEUE}\nToken: ${AI_TOKEN ? 'sim' : 'não'}`
  );
}));

// ============================================
// ENVIOS EM MASSA (BROADCASTS)
// ============================================

async function getAdsSettings() {
  try {
    const doc = await db.collection('settings').doc('ads').get();
    if (doc.exists && Array.isArray(doc.data().ads) && doc.data().ads.length > 0) {
      return doc.data().ads;
    }
    await db.collection('settings').doc('ads').set({ ads: DEFAULT_ADS, updatedAt: new Date() });
    return DEFAULT_ADS;
  } catch (error) {
    console.error('Erro ao obter configuração de anúncios, a usar padrão:', error);
    return DEFAULT_ADS;
  }
}

// Envia a um grupo; se o grupo migrou para supergrupo, reenvia já para o novo id.
async function sendBroadcastToGroup(groupId, text) {
  try {
    await sendTextTolerant(groupId, text);
    return true;
  } catch (error) {
    console.error(`Erro ao enviar para grupo ${groupId}:`, error.message);
    const outcome = await handleSendError(error, 'group', groupId).catch(() => 'transient');
    if (outcome === 'migrated') {
      const newId = error.response.body.parameters.migrate_to_chat_id;
      try {
        await sendTextTolerant(newId, text);
        return true;
      } catch (retryError) {
        console.error(`Erro ao reenviar para o novo id ${newId}:`, retryError.message);
      }
    }
    return false;
  }
}

async function sendBroadcastToUser(userId, text) {
  try {
    await sendTextTolerant(userId, text);
    return true;
  } catch (error) {
    console.error(`Erro ao enviar para utilizador ${userId}:`, error.message);
    await handleSendError(error, 'user', userId).catch(() => {});
    return false;
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
    if (await sendBroadcastToGroup(doc.data().chatId, text)) groupsSent++;
  }
  for (const doc of usersSnapshot.docs) {
    if (await sendBroadcastToUser(doc.data().userId, text)) usersSent++;
  }

  return {
    groupsSent,
    groupsTotal: groupsSnapshot.size,
    usersSent,
    usersTotal: usersSnapshot.size
  };
}

async function broadcastToGroupsOnly(text) {
  const groupsSnapshot = await db.collection('groups').where('active', '==', true).get();
  let sent = 0;
  for (const doc of groupsSnapshot.docs) {
    if (await sendBroadcastToGroup(doc.data().chatId, text)) sent++;
  }
  return { sent, total: groupsSnapshot.size };
}

async function broadcastToUsersOnly(text) {
  const usersSnapshot = await db.collection('users').where('active', '==', true).get();
  let sent = 0;
  for (const doc of usersSnapshot.docs) {
    if (await sendBroadcastToUser(doc.data().userId, text)) sent++;
  }
  return { sent, total: usersSnapshot.size };
}

// ============================================
// ANÚNCIOS AGENDADOS (cron, configuráveis em settings/ads)
// ============================================

// node-schedule não aceita "HH:MM": converte para cron "minuto hora * * *".
function timeToCron(time) {
  if (typeof time === 'string' && time.includes(' ')) {
    return time; // já é uma expressão cron
  }

  const match = /^(\d{1,2}):(\d{2})$/.exec(String(time).trim());
  if (!match) {
    console.error(`⚠️ Horário de anúncio inválido, a ignorar: "${time}"`);
    return null;
  }

  const hour = parseInt(match[1], 10);
  const minute = parseInt(match[2], 10);

  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    console.error(`⚠️ Horário de anúncio fora do intervalo, a ignorar: "${time}"`);
    return null;
  }

  return `${minute} ${hour} * * *`;
}

async function scheduleAnnouncements() {
  scheduledJobs.forEach((job) => {
    if (job && typeof job.cancel === 'function') job.cancel();
  });
  scheduledJobs = [];

  const ads = await getAdsSettings();
  let scheduledCount = 0;

  ads.forEach((ad) => {
    const cronExpression = timeToCron(ad.time);
    if (!cronExpression) return;

    const job = schedule.scheduleJob(cronExpression, async () => {
      console.log(`⏰ A disparar anúncio das ${ad.time}...`);
      try {
        const result = await broadcastToAll(ad.text);
        console.log(
          `✅ Anúncio das ${ad.time} enviado — grupos ${result.groupsSent}/${result.groupsTotal}, utilizadores ${result.usersSent}/${result.usersTotal}`
        );
      } catch (error) {
        console.error(`Erro ao disparar anúncio das ${ad.time}:`, error.message);
      }
    });

    if (job) {
      scheduledJobs.push(job);
      scheduledCount++;
    } else {
      console.error(`⚠️ Falha ao agendar anúncio das ${ad.time} (cron: "${cronExpression}")`);
    }
  });

  console.log(`✅ ${scheduledCount} anúncios agendados com sucesso`);
}

// Reagenda em tempo real quando o painel altera settings/ads
function watchAdsSettings() {
  db.collection('settings')
    .doc('ads')
    .onSnapshot(
      (doc) => {
        if (doc.exists) {
          console.log('🔄 Configuração de anúncios alterada, a reagendar...');
          scheduleAnnouncements().catch((error) => console.error('Erro ao reagendar anúncios:', error.message));
        }
      },
      (error) => console.error('Erro no listener de settings/ads:', error)
    );
}

// ============================================
// dashboard_commands — comandos gravados pelo painel diretamente no Firestore
// ============================================
// dashboard_commands/{id} = { type, payload, status: 'pending' -> 'done' | 'error' }
//   post_group        { chatId, message }
//   post_all_groups   { message }
//   notify_uid        { targetUid, message }
//   notify_all        { message }
//   reconcile_groups  {}
//   reply_message     { docId, text }              -> resposta do admin ao utilizador
//   edit_ai_message   { docId, text }              -> edita a resposta da IA
//   delete_ai_message { docId }                    -> apaga a resposta da IA
function watchDashboardCommands() {
  db.collection('dashboard_commands')
    .where('status', '==', 'pending')
    .onSnapshot(
      (snap) => {
        snap.docChanges().forEach((change) => {
          if (change.type !== 'added') return;
          processDashboardCommand(change.doc.ref, change.doc.data()).catch((error) => {
            console.error('Erro não tratado ao processar dashboard_command:', error.message);
          });
        });
      },
      (error) => console.error('Erro no listener de dashboard_commands:', error)
    );
}

async function processDashboardCommand(docRef, cmd) {
  const { type, payload } = cmd || {};
  try {
    switch (type) {
      case 'post_group': {
        const { chatId, message } = payload || {};
        if (!chatId || !message) throw new Error('payload.chatId e payload.message são obrigatórios.');
        await sendWithTyping(chatId, message, { parse_mode: 'Markdown' });
        break;
      }
      case 'post_all_groups': {
        const { message } = payload || {};
        if (!message) throw new Error('payload.message é obrigatório.');
        await broadcastToGroupsOnly(message);
        break;
      }
      case 'notify_uid': {
        const { targetUid, message } = payload || {};
        if (!targetUid || !message) throw new Error('payload.targetUid e payload.message são obrigatórios.');
        await sendWithTyping(targetUid, message, { parse_mode: 'Markdown' });
        break;
      }
      case 'notify_all': {
        const { message } = payload || {};
        if (!message) throw new Error('payload.message é obrigatório.');
        await broadcastToUsersOnly(message);
        break;
      }
      case 'reconcile_groups': {
        await reconcileGroups();
        break;
      }
      case 'reply_message': {
        const { docId, text } = payload || {};
        if (!docId || !text) throw new Error('payload.docId e payload.text são obrigatórios.');
        await replyToPrivateMessage(docId, text);
        break;
      }
      case 'edit_ai_message': {
        const { docId, text } = payload || {};
        if (!docId || !text) throw new Error('payload.docId e payload.text são obrigatórios.');
        await editAiMessage(docId, text);
        break;
      }
      case 'delete_ai_message': {
        const { docId } = payload || {};
        if (!docId) throw new Error('payload.docId é obrigatório.');
        await deleteAiMessage(docId);
        break;
      }
      default:
        throw new Error(`Tipo de comando desconhecido: "${type}"`);
    }

    await docRef.update({ status: 'done', processedAt: new Date() });
    console.log(`✅ dashboard_command "${type}" (${docRef.id}) processado com sucesso.`);
  } catch (error) {
    console.error(`Erro ao processar dashboard_command "${type}" (${docRef.id}):`, error.message);
    await docRef
      .update({ status: 'error', error: error.message, processedAt: new Date() })
      .catch(() => {});
  }
}

// ============================================
// INICIALIZAÇÃO
// ============================================

async function loadBotInfo() {
  try {
    botInfo = await bot.getMe();
    console.log(`🤖 Bot identificado como @${botInfo.username}`);
  } catch (error) {
    console.error('Erro ao obter informações do bot (nova tentativa em 15s):', error.message);
    setTimeout(() => loadBotInfo(), 15000);
  }
}

(async () => {
  let startPolling = !USE_WEBHOOK;

  try {
    if (USE_WEBHOOK) {
      // RAILWAY_PUBLIC_DOMAIN é injetado pelo Railway; PUBLIC_URL serve de override manual.
      const publicUrl =
        process.env.PUBLIC_URL ||
        (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : null);

      if (!publicUrl) {
        console.error(
          '⚠️ USE_WEBHOOK=true mas nem PUBLIC_URL nem RAILWAY_PUBLIC_DOMAIN estão definidos. A cair para polling.'
        );
        await bot.deleteWebHook({ drop_pending_updates: DROP_PENDING_UPDATES }).catch(() => {});
        startPolling = true;
      } else {
        const webhookUrl = `${publicUrl}${WEBHOOK_PATH}`;
        await bot.setWebHook(webhookUrl, { allowed_updates: JSON.stringify(ALLOWED_UPDATES) });
        console.log(`✅ Webhook configurado em ${webhookUrl}`);
      }
    } else {
      // Remove qualquer webhook/sessão residual (evita "409 Conflict" em deploys)
      await bot.deleteWebHook({ drop_pending_updates: DROP_PENDING_UPDATES }).catch(() => {});
    }
  } catch (error) {
    console.error('Erro ao configurar a receção de updates:', error.message);
  }

  await loadBotInfo();

  // O polling só arranca depois do getMe, para os handlers já terem o botInfo
  if (startPolling) {
    bot.startPolling().catch((error) => console.error('Erro ao iniciar o polling:', error.message));
  }

  await scheduleAnnouncements();
  watchAdsSettings();
  watchKeywords();
  watchDashboardCommands();

  // Reconciliação inicial: corrige grupos cujo estado ficou errado enquanto o bot esteve offline
  setTimeout(() => {
    reconcileGroups()
      .then((result) => {
        if (result.fixed > 0) {
          console.log(`🔧 Reconciliação inicial: ${result.fixed}/${result.checked} grupo(s) corrigido(s).`);
        } else {
          console.log(`🔍 Reconciliação inicial: ${result.checked} grupo(s) verificado(s), nenhum precisou de correção.`);
        }
      })
      .catch((error) => console.error('Erro na reconciliação inicial de grupos:', error.message));
  }, 5000);

  console.log('🤖 Bot Kanda Freelancer iniciado com sucesso!');
  console.log(`✅ Receção de updates: ${USE_WEBHOOK && !startPolling ? 'WEBHOOK' : 'POLLING'}`);
  console.log(
    AI_ENABLED
      ? `🧠 IA ativa (formato: ${AI_FORMAT}, timeout: ${AI_TIMEOUT_MS}ms, fila máx.: ${AI_MAX_QUEUE}) — o admin acompanha todas as conversas`
      : '🧠 IA desligada (KANDA_AI_URL não definida) — mensagens privadas seguem para o admin'
  );
  console.log('✅ Deteção de link SEMPRE ativa em grupo (admin ou não)');
  console.log('✅ Palavras-chave configuráveis pelo painel (tempo real)');
  console.log('✅ Painel: responder, editar/apagar resposta da IA, 2.ª resposta (REST + dashboard_commands)');
  console.log('');
  console.log('⚠️  Privacy Mode: para o bot ler texto normal em grupos onde NÃO é admin,');
  console.log('   desativa "Group Privacy" no @BotFather (Bot Settings -> Group Privacy -> Turn off)');
  console.log('   e volta a adicionar o bot ao grupo.');
})();

bot.on('polling_error', (error) => {
  console.error('Erro de polling:', error.message);
});

bot.on('webhook_error', (error) => {
  console.error('Erro de webhook:', error.message);
});

module.exports = bot;