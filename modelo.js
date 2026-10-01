require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const admin = require('firebase-admin');
const schedule = require('node-schedule');

// ============================================
// VALIDAÇÃO DE VARIÁVEIS DE AMBIENTE
// ============================================

const token = process.env.TELEGRAM_BOT_TOKEN;
const adminId = process.env.ADMIN_ID;
const firebaseConfigRaw = process.env.FIREBASE_CONFIG;

if (!token) {
  console.error('❌ ERRO FATAL: variável TELEGRAM_BOT_TOKEN não definida. O bot não pode arrancar sem o token do Telegram.');
  process.exit(1);
}

if (!adminId) {
  console.error('❌ ERRO FATAL: variável ADMIN_ID não definida. O bot não pode arrancar sem saber quem é o admin.');
  process.exit(1);
}

if (!firebaseConfigRaw) {
  console.error('❌ ERRO FATAL: variável FIREBASE_CONFIG não definida. O bot não pode arrancar sem as credenciais do Firebase.');
  process.exit(1);
}

let firestoreKey;
try {
  firestoreKey = JSON.parse(firebaseConfigRaw);
} catch (error) {
  console.error('❌ ERRO FATAL: FIREBASE_CONFIG não é um JSON válido:', error.message);
  process.exit(1);
}

// ============================================
// CONFIGURAÇÃO DA IA (SPACE DO TEU MODELO)
// ============================================
// [KANDA-IA] Define a URL do teu Space na variável de ambiente KANDA_AI_URL
// (ex.: https://o-teu-user-o-teu-space.hf.space/chat) — ou cola-a aqui
// diretamente no lugar da string vazia. Sem URL, a IA fica desligada e o bot
// continua a funcionar como antes (mensagem privada -> encaminhada ao admin).
//
//   KANDA_AI_URL         URL completa do endpoint que recebe a mensagem
//   KANDA_AI_TOKEN       (opcional) token, enviado como "Authorization: Bearer ..."
//                        — necessário se o Space for privado
//   KANDA_AI_FORMAT      'json' (padrão) -> POST { message, user_id, user_name }
//                        'gradio'        -> POST { data: [ message ] }
//   KANDA_AI_TIMEOUT_MS  tempo máximo de espera (padrão 45000). Um Space
//                        "adormecido" pode demorar a acordar na 1.ª chamada.
const AI_URL = (process.env.KANDA_AI_URL || '').trim();
const AI_TOKEN = (process.env.KANDA_AI_TOKEN || '').trim();
const AI_FORMAT = (process.env.KANDA_AI_FORMAT || 'json').trim().toLowerCase();
const AI_TIMEOUT_MS = parseInt(process.env.KANDA_AI_TIMEOUT_MS || '45000', 10);
const AI_ENABLED = AI_URL.length > 0;

// ============================================
// CONFIGURAÇÃO INICIAL
// ============================================

// allowed_updates explícito garante que o Telegram entrega o evento
// `my_chat_member` (bot adicionado/removido de grupos).
const bot = new TelegramBot(token, {
  polling: {
    params: { allowed_updates: ['message', 'callback_query', 'my_chat_member'] }
  }
});

try {
  admin.initializeApp({
    credential: admin.credential.cert(firestoreKey)
  });
  console.log('✅ Firebase inicializado com sucesso');
} catch (error) {
  console.error('❌ ERRO FATAL: falha ao inicializar o Firebase:', error.message);
  process.exit(1);
}

const db = admin.firestore();

// ============================================
// VARIÁVEIS GLOBAIS
// ============================================

const WARNINGS = new Map();
const BAN_THRESHOLD = 3;
const SITE_URL = 'https://kandafreelancer.surge.sh';
const ADMIN_CONTACT = 'https://t.me/zuacassongo';

// Grupos já confirmados como ativos nesta execução do processo
// (usado por registerGroup / ensureGroupRegistered / reconcileGroups).
const registeredGroupIds = new Set();

// Utilizadores cuja pergunta à IA ainda está a ser processada
// (evita que alguém dispare 10 pedidos seguidos ao Space).
const AI_BUSY = new Set();

// Utilizadores que pediram /start ou /novo: o próximo pedido à IA leva new_topic=true
const AI_RESET_NEXT = new Set();

// Anúncios padrão (usados apenas se ainda não existir configuração no Firestore).
// Quando o painel admin for criado, ele vai ler/escrever diretamente em settings/ads,
// e o bot reagirá automaticamente (ver watchAdsSettings()).
// O campo "time" fica no formato 'HH:MM' — é convertido para cron automaticamente
// pela função timeToCron() antes de ser passado ao node-schedule.
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
// PROTEÇÃO CONTRA CRASHES
// ============================================

// Envolve um handler para que qualquer erro não tratado fique apenas no log
// e nunca derrube o processo (Node 15+ termina em unhandled rejection).
function safe(fn) {
  return async (...args) => {
    try {
      await fn(...args);
    } catch (error) {
      console.error('❌ Erro não tratado num handler:', error && error.message ? error.message : error);
    }
  };
}

process.on('unhandledRejection', (reason) => {
  console.error('❌ unhandledRejection:', reason && reason.message ? reason.message : reason);
});

bot.on('polling_error', (error) => {
  // Ex.: "409 Conflict: terminated by other getUpdates request" durante deploys
  console.error('⚠️ polling_error:', error && error.message ? error.message : error);
});

// ============================================
// FUNÇÕES AUXILIARES BÁSICAS
// ============================================

// Converte 'HH:MM' para expressão cron ('M H * * *'), que é o formato
// que node-schedule realmente entende para agendamentos recorrentes diários.
// Se já vier um valor que pareça cron (tem espaços), devolve tal e qual.
function timeToCron(time) {
  if (typeof time !== 'string') return null;

  if (time.trim().includes(' ')) {
    // já parece ser uma expressão cron, usa diretamente
    return time.trim();
  }

  const match = time.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;

  const hour = parseInt(match[1], 10);
  const minute = parseInt(match[2], 10);

  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;

  return `${minute} ${hour} * * *`;
}

// [SUPER-FIX] Já não chama bot.getChat() a cada mensagem — o Telegram já
// entrega o tipo do chat em toda mensagem recebida (msg.chat.type). Usar
// esse campo diretamente elimina uma chamada de API por mensagem (mais
// rápido, menos hipótese de rate-limit, menos um ponto de falha).
function isGroupChatType(chatType) {
  return chatType === 'group' || chatType === 'supergroup';
}

// Mantida por compatibilidade, caso algum código externo ainda a chame
// diretamente com um chatId em vez de um objeto de mensagem.
async function isGroupChat(chatId) {
  try {
    const chat = await bot.getChat(chatId);
    return isGroupChatType(chat.type);
  } catch (error) {
    console.error('Erro ao verificar tipo de chat:', error.message);
    return false;
  }
}

// Nome amigável para mostrar em mensagens: @username se existir, senão o
// primeiro nome (evita mostrar "@João" quando a pessoa não tem username).
function displayName(from) {
  if (!from) return 'utilizador';
  return from.username ? `@${from.username}` : from.first_name || String(from.id);
}

// No Telegram, chat_id de grupos/supergrupos é negativo; o de utilizadores é positivo.
function chatKind(chatId) {
  return Number(chatId) < 0 ? 'group' : 'user';
}

// [SUPER-FIX] Classifica um erro do Telegram como "permanente" (o destino
// já não existe / não é mais alcançável, faz sentido desativar) ou
// "transitório" (rede, rate-limit, timeout — não deve desativar nada).
function isPermanentTelegramError(error) {
  const body = (error && error.response && error.response.body) || {};
  const desc = (body.description || error.message || '').toLowerCase();
  const statusCode = error && error.response && error.response.statusCode;

  if (statusCode === 403) return true; // bot bloqueado / removido / sem permissão
  return (
    desc.includes('chat not found') ||
    desc.includes('bot was blocked') ||
    desc.includes('user is deactivated') ||
    desc.includes('bot was kicked') ||
    desc.includes('peer_id_invalid')
  );
}

// [AJUSTE-1] Detecta especificamente o erro de parsing de Markdown/HTML do
// Telegram ("can't parse entities: ..."), para permitir um fallback seguro
// em vez de deixar a mensagem falhar por completo. Isto é DIFERENTE de
// isPermanentTelegramError: um erro de parsing não significa que o
// destinatário é inválido — significa que o TEXTO enviado tem sintaxe de
// formatação mal fechada (ex.: número ímpar de "*").
function isParseEntitiesError(error) {
  const body = (error && error.response && error.response.body) || {};
  const desc = (body.description || error.message || '').toLowerCase();
  return desc.includes("can't parse entities") || desc.includes('can\u2019t parse entities');
}

// [SUPER-FIX] Quando um grupo normal é promovido a supergrupo, o Telegram
// muda o chat_id e devolve o novo id em error.response.body.parameters.
// Em vez de simplesmente desativar o grupo "antigo" (o que o faz desaparecer
// do painel mesmo o bot continuando lá dentro), migramos o documento para
// o novo id automaticamente.
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

  // Erro transitório (inclui erros de parsing, que não devem desativar nada):
  // não mexe no estado, só regista.
  return 'transient';
}

// [AJUSTE-1] Envia texto livre (digitado por um admin ou vindo de um
// painel) tolerando negrito/itálico do Telegram OU texto totalmente
// simples, sem nunca falhar por causa de formatação mal fechada:
//   1. Tenta enviar com parse_mode: 'Markdown' — se o admin usou *negrito*,
//      _itálico_ etc. corretamente, o Telegram renderiza a formatação.
//   2. Se o Telegram devolver "can't parse entities" (ex.: número ímpar de
//      "*", tag mal fechada), a mensagem NÃO é descartada: reenviamos o
//      MESMO texto sem parse_mode nenhum, como texto simples. O
//      destinatário sempre recebe a mensagem — só perde a formatação
//      quando esta estava malformada.
async function sendTextTolerant(chatId, text, extraOptions = {}) {
  try {
    return await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', ...extraOptions });
  } catch (error) {
    if (isParseEntitiesError(error)) {
      console.warn(`⚠️  Texto com Markdown malformado para ${chatId} — reenviando como texto simples.`);
      // Reenvia sem parse_mode, mas preserva outras opções (ex.: reply_markup)
      const { parse_mode, ...rest } = extraOptions;
      return await bot.sendMessage(chatId, text, rest);
    }
    throw error;
  }
}

// Envia "digitando..." e só depois a mensagem, para parecer mais humano
// e para o usuário ver que o bot está a processar.
// [SUPER-FIX] Captura erros do sendMessage, classifica-os e atualiza o
// registo certo (grupo ou utilizador, deduzido pelo sinal do chat_id).
// [AJUSTE-1] Usa sendTextTolerant por baixo quando há parse_mode.
async function sendWithTyping(chatId, text, options = {}) {
  try {
    await bot.sendChatAction(chatId, 'typing');
    await new Promise((resolve) => setTimeout(resolve, 500 + Math.random() * 500));
  } catch (error) {
    // se falhar o "typing" não é crítico, seguimos para enviar a mensagem
  }

  try {
    if (options && options.parse_mode) {
      return await sendTextTolerant(chatId, text, options);
    }
    return await bot.sendMessage(chatId, text, options);
  } catch (error) {
    console.error(`Erro ao enviar mensagem para ${chatId}:`, error.message);
    await handleSendError(error, chatKind(chatId), chatId).catch(() => {});
    throw error; // quem chamou decide como reagir (ou o safe() apanha)
  }
}

// Verifica se o bot é administrador do grupo e se pode apagar mensagens.
// Usado para decidir se apaga a mensagem com link — mas a DETEÇÃO do link
// e o AVISO ao utilizador acontecem sempre, mesmo que o bot não seja admin.
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

// Verifica se o bot tem permissão para restringir/banir membros.
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

// Deteção de link — SEM flag global (g), para nunca depender de lastIndex
// entre chamadas (esse era o bug que fazia o aviso funcionar de forma
// inconsistente). Cria o regex de novo a cada chamada.
function containsLink(text) {
  return /https?:\/\/[^\s]+|www\.[^\s]+/i.test(text || '');
}

// ============================================
// PERSISTÊNCIA (GRUPOS, UTILIZADORES, BANS...)
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

// [NOVO] Regista/atualiza um grupo a partir do evento `my_chat_member`
// (disparado sempre que o bot é adicionado/removido/promovido num grupo).
// Grava os campos pedidos pelo painel (title, type, status, addedBy,
// addedByName, addedAt) SEM remover os campos antigos (name, active),
// que continuam a ser usados pelo resto do bot (broadcastToAll, /stats,
// etc.) — os dois esquemas coexistem no mesmo documento.
//
// [SUPER-FIX] O critério de "o bot continua no grupo" é uma LISTA NEGRA
// (tudo exceto 'left'/'kicked'), não uma lista branca. O Telegram tem
// outros estados possíveis — o mais comum é 'restricted' — e com a lista
// branca antiga um grupo nesse estado era gravado como "removed" mesmo com
// o bot lá dentro, por isso desaparecia do painel.
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
        rawStatus: newStatus || null, // status bruto do Telegram, para diagnóstico
        addedBy: from.id || null,
        addedByName,
        addedAt: new Date(),
        // campos legados, mantidos por compatibilidade com o resto do código:
        name: chat.title || chat.username || String(chat.id),
        active: isActiveMember
      },
      { merge: true }
    );

    if (isActiveMember) {
      registeredGroupIds.add(String(chat.id));
    } else {
      registeredGroupIds.delete(String(chat.id));
    }

    console.log(`👥 my_chat_member: grupo "${chat.title || chat.id}" -> status "${newStatus}"`);

    // Se o bot ficou "restricted", avisa o admin (sem marcar o grupo como inativo).
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

// [AJUSTE-2] REDE DE SEGURANÇA para captura de grupos: garante que
// QUALQUER grupo onde o bot esteja presente fica registado/ativo no
// Firestore, mesmo que o evento `my_chat_member` correspondente se tenha
// perdido (ex.: por causa do erro "409 Conflict" durante um deploy no
// Railway, quando duas instâncias competem pelo polling).
//
// Só escreve no Firestore quando o grupo ainda não foi visto nesta
// execução (registeredGroupIds).
async function ensureGroupRegistered(chat) {
  if (!chat || !chat.id) return;
  const chatIdStr = String(chat.id);
  if (registeredGroupIds.has(chatIdStr)) return; // já confirmado nesta execução

  try {
    await db.collection('groups').doc(chatIdStr).set(
      {
        chatId: chat.id,
        title: chat.title || chat.username || chatIdStr,
        type: chat.type || null,
        status: 'active',
        active: true,
        // campo legado mantido por compatibilidade com broadcastToAll/etc.
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

// [SUPER-FIX] Reconciliação sob demanda: para cada grupo marcado no
// Firestore, confirma junto do Telegram (getChatMember do próprio bot)
// se o estado ainda é verdadeiro, e corrige o registo se não for.
async function reconcileGroups() {
  if (!botInfo) return { checked: 0, fixed: 0 };

  const snap = await db.collection('groups').get();
  let checked = 0;
  let fixed = 0;

  for (const doc of snap.docs) {
    const group = doc.data();
    if (group.status === 'migrated') continue; // id antigo, já migrado
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
        console.log(`🔧 Reconciliado grupo "${group.title || chatId}": active=${stillActive} (status Telegram: ${member.status})`);
      }
      if (stillActive) registeredGroupIds.add(String(chatId));
    } catch (error) {
      // Se getChatMember falha com "chat not found"/"Forbidden", o bot
      // realmente já não está lá — marca como inativo.
      if (isPermanentTelegramError(error) && group.active) {
        await doc.ref.set({ active: false, status: 'removed' }, { merge: true });
        fixed++;
        console.log(`🔧 Reconciliado grupo "${group.title || chatId}": marcado inativo (${error.message})`);
      }
    }
  }

  return { checked, fixed };
}

// Grava o perfil completo do utilizador (nome, apelido, @username) sempre que
// ele envia /start ou uma mensagem de texto — para o painel admin conseguir
// identificar quem é quem, não só o ID numérico.
async function registerUser(fromInfo) {
  try {
    await db.collection('users').doc(String(fromInfo.id)).set(
      {
        userId: fromInfo.id,
        username: fromInfo.username || null,
        firstName: fromInfo.first_name || null,
        lastName: fromInfo.last_name || null,
        // mantido por compatibilidade com o resto do código que já usa "userName"
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

// Restringe um utilizador (silencia — não pode enviar mensagens) por um
// determinado número de minutos. Usado como alternativa ao ban direto.
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

// Grava um registo simples de que foi detetado um link no grupo — útil
// para o painel mostrar histórico de ocorrências, mesmo quando o bot não
// tem permissões de moderação.
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

// Regista a mensagem privada e devolve o ID do documento (usado para
// depois ligar a resposta do admin de volta ao utilizador certo).
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

// [KANDA-IA] Regista no documento da mensagem privada o que a IA respondeu.
// A mensagem fica como "respondida" (responded=true) mas NÃO é dada como
// vista (adminViewed continua false), para continuar na lista do painel e o
// admin poder ler a resposta do modelo. O painel pode dá-la como vista com
// POST /api/messages/:id/seen.
async function markPrivateMessageAnsweredByAI(docId, answer) {
  if (!docId) return;
  try {
    await db.collection('private_messages').doc(docId).update({
      responded: true,
      answeredByAI: true,
      aiAnswer: String(answer || ''),
      aiAnsweredAt: new Date()
    });
  } catch (error) {
    console.error('Erro ao registar resposta da IA na mensagem:', error);
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
// IA: COMUNICAÇÃO COM O SPACE DO MODELO
// ============================================

// Extrai o texto da resposta, aceitando os formatos mais comuns:
//   { answer | response | reply | text | generated_text | output | message: "..." }
//   [ { generated_text: "..." } ]      (Inference API / pipelines)
//   { data: [ "..." ] }                (Gradio)
//   "texto simples"
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

// Uma tentativa de pedido ao Space, com timeout. Devolve o texto ou lança erro.
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
            // O main.py (FastAPI/pydantic v2) exige user_id como STRING;
            // um número daria erro 422.
            user_id: String(fromInfo.id),
            message: text,
            channel: 'telegram', // mantém a memória de conversa separada da web
            new_topic: newTopic,
            user_name: fromInfo.username || fromInfo.first_name || null // ignorado pelo main.py
          };

    const res = await fetch(AI_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    if (!res.ok) {
      throw new Error(`Space respondeu HTTP ${res.status}`);
    }

    const raw = await res.text();
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      parsed = raw; // resposta em texto simples
    }

    const answer = extractAIText(parsed);
    if (!answer || !answer.trim()) {
      throw new Error('Resposta do Space vazia ou em formato desconhecido');
    }
    return answer.trim();
  } finally {
    clearTimeout(timer);
  }
}

// Pergunta ao modelo. Faz 1 nova tentativa (o Space pode estar a acordar).
// Devolve o texto da resposta, ou null se a IA estiver desligada/falhar.
async function askKandaAI(fromInfo, text) {
  if (!AI_ENABLED) return null;

  // /start e /novo pedem "assunto novo": a flag vale só para o próximo pedido
  const newTopic = AI_RESET_NEXT.delete(fromInfo.id);

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const answer = await callAIOnce(fromInfo, text, newTopic);
      // Telegram limita mensagens a 4096 caracteres
      return answer.length > 4000 ? `${answer.slice(0, 3990)}…` : answer;
    } catch (error) {
      const reason = error.name === 'AbortError' ? `timeout de ${AI_TIMEOUT_MS}ms` : error.message;
      console.error(`⚠️ IA falhou (tentativa ${attempt}/2): ${reason}`);
      if (attempt < 2) await new Promise((r) => setTimeout(r, 2000));
    }
  }
  return null;
}

// Mantém o indicador "digitando..." visível enquanto a IA pensa.
function keepTyping(chatId) {
  bot.sendChatAction(chatId, 'typing').catch(() => {});
  const interval = setInterval(() => {
    bot.sendChatAction(chatId, 'typing').catch(() => {});
  }, 4000);
  return () => clearInterval(interval);
}

// Encaminha uma mensagem privada ao admin (fluxo original de relay).
async function forwardToAdmin(docId, msg, text, note = '') {
  const from = msg.from;
  const sentToAdmin = await sendWithTyping(
    adminId,
    `📨 *Mensagem Privada*${note}\n\nDe: ${displayName(from)} (${from.id})\n\n"${text}"\n\nResponda a ESTA mensagem para falar diretamente com o utilizador.`,
    { parse_mode: 'Markdown' }
  );
  await linkPrivateMessageToAdminMessage(docId, sentToAdmin.message_id);
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

// Nos chats privados com IA ativa, é o modelo que responde — por isso as
// respostas automáticas por palavra-chave ficam só para grupos. O chat do
// admin também é ignorado (ele escreve "?" ao responder a utilizadores).
function skipCannedReply(msg) {
  if (isGroupChatType(msg.chat.type)) return false;
  if (String(msg.chat.id) === String(adminId)) return true;
  return AI_ENABLED;
}

bot.onText(/^\/start$/, safe(async (msg) => {
  const chatId = msg.chat.id;

  if (isGroupChatType(msg.chat.type)) {
    await registerGroup(chatId, msg.chat.title);
    const welcomeMsg = `🤖 *Kanda Freelancer Bot Ativado!*\n\n✅ Sistema de proteção contra links ativado\n✅ Anúncios automáticos configurados\n✅ Painel administrativo disponível\n\nPara mais informações, envie mensagens privadas ao bot!`;
    await sendWithTyping(chatId, welcomeMsg, { parse_mode: 'Markdown', ...groupWelcomeKeyboard() });
  } else {
    await registerUser(msg.from);
    AI_RESET_NEXT.add(msg.from.id); // /start = conversa nova para o main.py (new_topic)
    await sendWithTyping(
      chatId,
      AI_ENABLED
        ? '👋 Olá! Sou o assistente da Kanda Freelancer. Escreve a tua dúvida e eu respondo já.'
        : '👋 Olá! Envie-me mensagens privadas e irei responder assim que possível.',
      mainMenuKeyboard()
    );
  }
}));

// [KANDA-IA] /novo (ou /reset, /limpar): o utilizador começa um assunto novo e o
// main.py deixa de usar as trocas anteriores como memória. Só em chat privado.
bot.onText(/^\/(novo|reset|limpar)(@\w+)?$/i, safe(async (msg) => {
  if (msg.chat.type !== 'private' || !msg.from) return;
  AI_RESET_NEXT.add(msg.from.id);
  await sendWithTyping(msg.chat.id, 'Certo, vamos começar um assunto novo. Como posso ajudar?');
}));

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

bot.onText(/\?/, safe(async (msg) => {
  if (skipCannedReply(msg)) return;
  await sendWithTyping(msg.chat.id, HELP_TEXT, { parse_mode: 'Markdown', ...mainMenuKeyboard() });
}));

bot.onText(/como funciona|como trabaja|como trabalha/i, safe(async (msg) => {
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

  await sendWithTyping(msg.chat.id, response, { parse_mode: 'Markdown', ...mainMenuKeyboard() });
}));

bot.onText(/quero trabalhar|preciso de ajuda|tenho dificuldade/i, safe(async (msg) => {
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

// Responde ao clique no botão "Como Funciona" sem sair do chat
bot.on('callback_query', safe(async (query) => {
  if (query.data === 'como_funciona') {
    await bot.answerCallbackQuery(query.id);
    if (query.message) {
      await sendWithTyping(query.message.chat.id, HELP_TEXT, { parse_mode: 'Markdown' });
    }
  }
}));

// ============================================
// EVENTO: BOT ADICIONADO / REMOVIDO / PROMOVIDO
// ============================================

bot.on('my_chat_member', safe(async (upd) => {
  const type = upd.chat && upd.chat.type;

  if (isGroupChatType(type)) {
    await registerGroupFromChatMember(upd);
    return;
  }

  // Chat privado: se o utilizador bloqueou o bot, deixa de receber anúncios
  if (type === 'private') {
    const status = upd.new_chat_member && upd.new_chat_member.status;
    const active = !['left', 'kicked'].includes(status);
    await db
      .collection('users')
      .doc(String(upd.chat.id))
      .update({ active })
      .catch(() => {}); // se o utilizador nunca foi registado, ignora
  }
}));

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
      const who = original.username ? `@${original.username}` : original.firstName || original.userName || original.userId;
      await bot.sendMessage(msg.chat.id, `✅ Resposta enviada a ${who}.`);
      return true; // tratado, não continuar
    }
  }

  return false; // não era uma resposta a um utilizador, segue fluxo normal (comandos /admin, etc.)
}

// ============================================
// MENSAGENS GERAIS (PRIVADO, GRUPO, MÍDIA)
// ============================================

bot.on('message', safe(async (msg) => {
  if (!msg.from) return; // posts de canal, etc.

  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const userName = msg.from.username || msg.from.first_name;
  const text = msg.text || '';

  const isGroup = isGroupChatType(msg.chat.type);

  // ---------- CHAT PRIVADO DO PRÓPRIO ADMIN ----------
  if (!isGroup && chatId === parseInt(adminId, 10)) {
    if (text && !text.startsWith('/')) {
      const handled = await handleAdminChat(msg);
      if (handled) return;
    }
    return; // comandos de admin (/admin, /jobs...) são tratados pelos onText próprios
  }

  // ---------- MENSAGENS PRIVADAS DE UTILIZADORES COMUNS ----------
  if (!isGroup) {
    if (msg.chat.type !== 'private') return; // ignora canais/outros tipos

    await registerUser(msg.from);

    if (!text || text.startsWith('/')) return;

    const docId = await logPrivateMessage(msg.from, text, msg.message_id);

    // [KANDA-IA] 1) tenta responder com o modelo do Space
    if (AI_ENABLED) {
      if (AI_BUSY.has(userId)) {
        await bot.sendMessage(chatId, '⏳ Ainda estou a responder à tua mensagem anterior. Só um instante!');
        return;
      }

      AI_BUSY.add(userId);
      const stopTyping = keepTyping(chatId);
      let answer = null;
      try {
        answer = await askKandaAI(msg.from, text);
      } finally {
        stopTyping();
        AI_BUSY.delete(userId);
      }

      if (answer) {
        // Enviado como texto simples (sem parse_mode) — a saída de um modelo
        // pode ter "*" ou "_" soltos que o Markdown do Telegram rejeitaria.
        await sendWithTyping(chatId, answer);
        await markPrivateMessageAnsweredByAI(docId, answer);
        return;
      }

      // 2) IA indisponível: cai no fluxo antigo (admin responde à mão)
      await forwardToAdmin(docId, msg, text, ' _(IA indisponível)_');
      await sendWithTyping(
        chatId,
        '✅ Sua mensagem foi recebida! O assistente está indisponível agora, mas o administrador responderá em breve.'
      );
      return;
    }

    // IA desligada: fluxo original
    await forwardToAdmin(docId, msg, text);
    await sendWithTyping(chatId, '✅ Sua mensagem foi recebida! O administrador responderá em breve.');
    return;
  }

  // ---------- DENTRO DE GRUPOS ----------
  // [AJUSTE-2] rede de segurança: qualquer mensagem de grupo confirma que o
  // grupo está registado/ativo, mesmo que o my_chat_member se tenha perdido.
  await ensureGroupRegistered(msg.chat);

  // O bot não deve processar fotos, vídeos, stickers, documentos, etc.
  // Só lê texto. Se tiver permissão de admin no grupo, remove a mídia.
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
    // sem permissão de admin, o bot simplesmente ignora a mídia (não lê, não processa)
    return;
  }

  if (!text) return; // ignora qualquer outro tipo de conteúdo não textual

  if (!containsLink(text)) return;

  const isBanned = await isUserBanned(chatId, userId);
  if (isBanned) return; // já banido, nada a fazer

  // Histórico de ocorrências para o painel (mesmo sem permissões de moderação)
  await logLinkDetection(chatId, msg.chat.title, msg.from, text);

  const canModerate = await botCanModerate(chatId);

  if (canModerate) {
    try {
      await bot.deleteMessage(chatId, msg.message_id);
    } catch (error) {
      console.error('Erro ao deletar mensagem com link:', error.message);
    }
  }

  const warningCount = await addWarning(chatId, userId, userName);
  const who = displayName(msg.from);

  if (warningCount >= BAN_THRESHOLD) {
    // Banir exige a permissão "restringir membros", diferente da de apagar mensagens
    if (await botCanRestrict(chatId)) {
      await banUser(chatId, userId, userName);
      await sendWithTyping(
        chatId,
        `⛔ *Usuário Banido*\n\n${who} foi removido por publicação repetida de links.`,
        { parse_mode: 'Markdown' }
      );
    } else {
      await sendWithTyping(
        adminId,
        `⚠️ ${who} atingiu ${BAN_THRESHOLD} avisos por links no grupo "${msg.chat.title}", mas o bot não tem permissão para banir.`
      );
    }
  } else {
    const warningMsg = await sendWithTyping(
      chatId,
      `⚠️ *Aviso para ${who}*\n\n🚫 Links não são permitidos aqui!\n\n${
        canModerate ? '❌ Sua mensagem foi removida.\n' : ''
      }⚠️ Aviso ${warningCount}/${BAN_THRESHOLD}\n\n⛔ Se receber ${BAN_THRESHOLD} avisos, será banido!\n\n📌 Envie mensagens privadas ao bot para sugestões.`,
      { parse_mode: 'Markdown' }
    );

    setTimeout(() => {
      bot.deleteMessage(chatId, warningMsg.message_id).catch(() => {});
    }, 30000);
  }
}));

// ============================================
// COMANDOS ADMINISTRATIVOS (via Telegram — sem painel web ainda)
// ============================================

function isAdmin(chatId) {
  return chatId === parseInt(adminId, 10);
}

bot.onText(/\/admin/, safe(async (msg) => {
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
/unban [groupId] [userId] - Remover banimento
/reconcile - Sincronizar grupos com o Telegram
/ia - Ver estado da IA`;

  await sendWithTyping(chatId, adminPanel, { parse_mode: 'Markdown' });
}));

bot.onText(/\/jobs/, safe(async (msg) => {
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

bot.onText(/\/messages/, safe(async (msg) => {
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
    let i = 0;
    messagesSnapshot.forEach((doc) => {
      i++;
      const data = doc.data();
      const who = data.username ? `@${data.username}` : data.firstName || data.userName;
      messagesList += `${i}. ${who} (${data.userId})${data.answeredByAI ? ' 🤖 respondida pela IA' : ''}\n`;
      messagesList += `   "${data.text}"\n`;
      if (data.answeredByAI && data.aiAnswer) {
        messagesList += `   ↳ IA: "${String(data.aiAnswer).substring(0, 150)}${data.aiAnswer.length > 150 ? '…' : ''}"\n`;
      }
      messagesList += '\n';
    });
    messagesList += 'ℹ️ Para responder, vá à mensagem encaminhada diretamente e clique em "Responder".';

    await sendWithTyping(chatId, messagesList, { parse_mode: 'Markdown' });
  } catch (error) {
    console.error('Erro ao listar mensagens:', error);
    await sendWithTyping(chatId, '❌ Erro ao listar mensagens.');
  }
}));

bot.onText(/\/stats/, safe(async (msg) => {
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
}));

bot.onText(/\/banned/, safe(async (msg) => {
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

bot.onText(/\/unban (-?\d+) (\d+)/, safe(async (msg, match) => {
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

bot.onText(/\/broadcast ([\s\S]+)/, safe(async (msg, match) => {
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

// [NOVO] Sincroniza sob demanda o estado dos grupos no Firestore com o Telegram.
bot.onText(/\/reconcile/, safe(async (msg) => {
  const chatId = msg.chat.id;
  if (!isAdmin(chatId)) return sendWithTyping(chatId, '❌ Acesso negado.');

  await sendWithTyping(chatId, '🔧 A sincronizar grupos com o Telegram...');
  const result = await reconcileGroups();
  await bot.sendMessage(chatId, `✅ Verificados: ${result.checked} | Corrigidos: ${result.fixed}`);
}));

// [KANDA-IA] Mostra se a IA está configurada (sem expor a URL completa).
bot.onText(/^\/ia$/, safe(async (msg) => {
  const chatId = msg.chat.id;
  if (!isAdmin(chatId)) return sendWithTyping(chatId, '❌ Acesso negado.');

  if (!AI_ENABLED) {
    await bot.sendMessage(chatId, '🤖 IA desligada: defina KANDA_AI_URL para ativar. Mensagens privadas seguem para si.');
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
    `🤖 IA ativa\nHost: ${host}\nFormato: ${AI_FORMAT}\nTimeout: ${AI_TIMEOUT_MS}ms\nToken: ${AI_TOKEN ? 'sim' : 'não'}`
  );
}));

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
    console.error('❌ Erro ao obter configuração de anúncios do Firestore, a usar padrão local:', error.message);
    return DEFAULT_ADS;
  }
}

// [SUPER-FIX] Usa sendTextTolerant (Markdown malformado não derruba o envio)
// e handleSendError (migra grupos que viraram supergrupo; só desativa em
// erros permanentes, nunca em erros transitórios).
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
      await sendTextTolerant(groupId, text);
      groupsSent++;
    } catch (error) {
      console.error(`Erro ao enviar anúncio para grupo ${groupId}:`, error.message);
      const outcome = await handleSendError(error, 'group', groupId);
      if (outcome === 'migrated') {
        // reenvia já para o novo id
        const newId = error.response.body.parameters.migrate_to_chat_id;
        try {
          await sendTextTolerant(newId, text);
          groupsSent++;
        } catch (retryError) {
          console.error(`Erro ao reenviar para o novo id ${newId}:`, retryError.message);
        }
      }
    }
  }

  for (const doc of usersSnapshot.docs) {
    const userId = doc.data().userId;
    try {
      await sendTextTolerant(userId, text);
      usersSent++;
    } catch (error) {
      console.error(`Erro ao enviar anúncio para utilizador ${userId}:`, error.message);
      await handleSendError(error, 'user', userId);
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
  // proteção: só chama .cancel() em jobs que realmente existem (não são null)
  scheduledJobs.forEach((job) => {
    if (job) job.cancel();
  });
  scheduledJobs = [];

  const ads = await getAdsSettings();
  let scheduledCount = 0;

  ads.forEach((ad) => {
    const cronTime = timeToCron(ad.time);

    if (!cronTime) {
      console.error(`⚠️ Horário inválido para anúncio: "${ad.time}" — este anúncio não foi agendado.`);
      return;
    }

    const job = schedule.scheduleJob(cronTime, safe(async () => {
      console.log(`⏰ A disparar anúncio das ${ad.time}...`);
      const result = await broadcastToAll(ad.text);
      console.log(
        `✅ Anúncio das ${ad.time} enviado — grupos ${result.groupsSent}/${result.groupsTotal}, utilizadores ${result.usersSent}/${result.usersTotal}`
      );
    }));

    if (!job) {
      console.error(`⚠️ Falha ao criar job para o anúncio das "${ad.time}" (cron: "${cronTime}").`);
      return;
    }

    scheduledJobs.push(job);
    scheduledCount++;
  });

  console.log(`✅ ${scheduledCount}/${ads.length} anúncios agendados com sucesso`);
}

// Reagenda automaticamente sempre que a configuração de anúncios mudar no Firestore
// (útil quando o futuro painel admin editar os horários/textos diretamente na base de dados)
function watchAdsSettings() {
  db.collection('settings')
    .doc('ads')
    .onSnapshot(
      (doc) => {
        if (doc.exists) {
          console.log('🔄 Configuração de anúncios alterada, a reagendar...');
          scheduleAnnouncements().catch((e) => console.error('Erro ao reagendar anúncios:', e.message));
        }
      },
      (error) => {
        console.error('❌ Erro ao observar configuração de anúncios no Firestore:', error.message);
      }
    );
}

// ============================================
// INICIALIZAÇÃO
// ============================================

(async () => {
  try {
    botInfo = await bot.getMe();
    console.log(`🤖 Bot identificado como @${botInfo.username}`);
  } catch (error) {
    console.error('❌ ERRO FATAL: não foi possível autenticar no Telegram — verifica se TELEGRAM_BOT_TOKEN está correto:', error.message);
    process.exit(1);
  }

  console.log(
    AI_ENABLED
      ? `🧠 IA ativa (formato: ${AI_FORMAT}, timeout: ${AI_TIMEOUT_MS}ms)`
      : '🧠 IA desligada (KANDA_AI_URL não definida) — mensagens privadas seguem para o admin.'
  );

  await scheduleAnnouncements();
  watchAdsSettings();

  // Reconciliação inicial: corrige grupos cujo evento my_chat_member se perdeu
  reconcileGroups()
    .then((r) => console.log(`🔧 Reconciliação inicial: ${r.checked} grupos verificados, ${r.fixed} corrigidos.`))
    .catch((e) => console.error('Erro na reconciliação inicial:', e.message));

  console.log('✅ Bot pronto e a escutar mensagens.');
})();
