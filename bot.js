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

const WARNINGS = new Map();
const BAN_THRESHOLD = 3;
const SITE_URL = 'https://kandafreelancer.surge.sh';
const ADMIN_CONTACT = 'https://t.me/zuacassongo';

// Anúncios padrão (usados apenas se ainda não existir configuração no Firestore).
// O painel admin lê/escreve diretamente em settings/ads, e o bot reagirá
// automaticamente em tempo real (ver watchAdsSettings()) — os anúncios saem
// exatamente na hora marcada (cron local, via node-schedule).
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
let scheduledJobs = [];      // jobs de node-schedule ativos (anúncios)

// ============================================
// [KEYWORDS] Sistema de palavras-chave (configurável pelo painel)
// ============================================
// Coleção Firestore: keywords/{id} = { pattern, response, matchType, active }
//   pattern    -> texto/expressão a procurar
//   response   -> texto que o bot envia no GRUPO quando a palavra é detetada
//   matchType  -> 'contains' (padrão) | 'exact' | 'regex'
//   active     -> true/false (permite desligar sem apagar)
//
// Como funciona: o bot lê TODO texto enviado em grupo (ver Privacy Mode nas
// notas de arranque), compara com a lista de palavras-chave marcadas como
// ativas no painel, e SÓ responde se houver correspondência. Se o texto não
// corresponder a nenhuma palavra-chave, o bot não responde nada e segue a
// rotina normal (deteção de link continua a funcionar sempre, é uma
// verificação independente e prioritária).
let KEYWORDS_CACHE = [];

function watchKeywords() {
  db.collection('keywords').onSnapshot(
    (snap) => {
      KEYWORDS_CACHE = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
      console.log(`🔑 Palavras-chave sincronizadas (${KEYWORDS_CACHE.length} no total, painel em tempo real).`);
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
  // 'contains' (padrão)
  return t.includes(p);
}

// Procura a primeira palavra-chave que corresponda ao texto e devolve a
// resposta configurada, ou null se nada corresponder.
function findKeywordResponse(text) {
  for (const keyword of KEYWORDS_CACHE) {
    if (matchKeyword(text, keyword)) {
      return keyword;
    }
  }
  return null;
}

// ============================================
// SERVIDOR HTTP (Express)
// Serve para o Railway gerar domínio (o bot em si funciona por polling
// e não precisa de HTTP) E para o painel admin poder:
//  - avisar o utilizador que "o admin está a escrever..." (/api/typing)
//  - enviar uma resposta de texto ao utilizador (/api/reply)
//  - gerir palavras-chave, anúncios, trabalhos, banimentos, etc.
// ============================================
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const path = require('path');

const PORT = process.env.PORT || 3000;

// Token opcional para proteger os endpoints do painel. Define
// ADMIN_PANEL_TOKEN nas variáveis de ambiente e envia o mesmo valor
// no header "x-admin-token" a partir do painel. Sem isto configurado,
// os endpoints ficam abertos — recomendado definir em produção.
const PANEL_TOKEN = process.env.ADMIN_PANEL_TOKEN;

function requirePanelToken(req, res, next) {
  if (!PANEL_TOKEN || req.headers['x-admin-token'] === PANEL_TOKEN) return next();
  return res.status(401).json({ error: 'Não autorizado' });
}

const app = express();
// CSP desativado porque o painel admin usa <script>/<style> inline num único
// ficheiro; os restantes cabeçalhos de segurança do helmet continuam ativos.
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors()); // ajusta { origin: 'https://teu-painel.com' } quando o painel tiver domínio fixo
app.use(morgan('tiny'));
app.use(express.json());
app.use('/admin', express.static(path.join(__dirname, 'public/admin')));

// Painel admin: mostrar ao utilizador o indicador "a escrever..." do Telegram
// enquanto o admin está a compor uma resposta no painel.
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

// Painel admin: enviar uma resposta de texto a um utilizador específico
// e (opcionalmente) marcar a mensagem original como respondida no Firestore.
// IMPORTANTE: o utilizador recebe SÓ o texto puro, sem prefixo "Resposta do
// Admin:" — para o utilizador, parece uma resposta normal do próprio bot.
app.post('/api/reply', requirePanelToken, async (req, res) => {
  try {
    const { userId, text, docId } = req.body;
    if (!userId || !text) return res.status(400).json({ error: 'userId e text são obrigatórios' });

    await sendWithTyping(userId, text);
    if (docId) {
      await markPrivateMessageResponded(docId);
    }
    res.json({ ok: true });
  } catch (error) {
    console.error('Erro ao enviar resposta pelo painel:', error.message);
    res.status(500).json({ error: 'Erro ao processar pedido' });
  }
});

// Painel admin: login. Compara com ADMIN_PANEL_USER / ADMIN_PANEL_PASS
// (variáveis de ambiente) e, se corretas, devolve o token que o painel
// deve usar no header "x-admin-token" em todos os pedidos seguintes.
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

// Painel admin: estatísticas para o dashboard
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

// Painel admin: listar e criar trabalhos pendentes
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

// Painel admin: publicar um trabalho nos grupos e marcá-lo como publicado
app.post('/api/jobs/:id/post', requirePanelToken, async (req, res) => {
  try {
    const jobRef = db.collection('jobs').doc(req.params.id);
    const jobDoc = await jobRef.get();
    if (!jobDoc.exists) return res.status(404).json({ error: 'Trabalho não encontrado.' });

    const job = jobDoc.data();
    const text = `💼 *Novo Trabalho Disponível!*\n\n${job.title}\n💰 Valor: ${job.value}\n📝 ${job.description}\n\n${SITE_URL}`;
    const result = await broadcastToAll(text);
    await jobRef.update({ postedToGroups: true });
    res.json({ ok: true, result });
  } catch (error) {
    console.error('Erro ao publicar trabalho (painel):', error.message);
    res.status(500).json({ error: 'Erro ao publicar trabalho.' });
  }
});

// Painel admin: mensagens privadas por responder
app.get('/api/messages', requirePanelToken, async (req, res) => {
  try {
    const snap = await db
      .collection('private_messages')
      .where('adminViewed', '==', false)
      .orderBy('timestamp', 'desc')
      .limit(20)
      .get();
    const messages = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    res.json({ messages });
  } catch (error) {
    console.error('Erro ao listar mensagens (painel):', error.message);
    res.status(500).json({ error: 'Erro ao listar mensagens.' });
  }
});

// Painel admin: ler e guardar a configuração de anúncios agendados
// (guardar aqui dispara automaticamente watchAdsSettings() -> scheduleAnnouncements()
// e os novos horários entram em vigor imediatamente, sem reiniciar o bot)
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

// Painel admin: broadcast imediato (admin escreve texto livre, como neste bot)
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

// Painel admin: listar e remover banimentos
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

// [KEYWORDS] Painel admin: listar, criar/atualizar e apagar palavras-chave
// Cada entrada: { pattern, response, matchType, active }
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

// Health check simples (e resposta padrão para qualquer outra rota)
app.get('/', (req, res) => {
  res.type('text/plain').send('Kanda Freelancer Bot está ativo ✅');
});

app.listen(PORT, () => {
  console.log(`🌐 Servidor HTTP (Express) a escutar na porta ${PORT}`);
});

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
// Usado para decidir se apaga a mensagem com link e se pode banir — mas
// a DETEÇÃO do link e o AVISO ao utilizador acontecem sempre, mesmo que o
// bot não seja admin (ver handler de grupo mais abaixo).
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

// Verifica se o bot tem permissão para restringir/silenciar membros
// (usado como alternativa mais branda ao banimento, se disponível).
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
      { chatId, name, addedAt: new Date(), active: true },
      { merge: true }
    );
  } catch (error) {
    console.error('Erro ao registrar grupo:', error);
  }
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
        ],
        [
          { text: '🔒 Política de Privacidade', callback_data: 'politica_privacidade' }
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

// [FIX] Em grupos o Telegram costuma enviar "/start@NomeDoBot" (para
// desambiguar quando há vários bots no grupo). O regex agora aceita ambos:
// "/start" (privado) e "/start@NomeDoBot" (grupo).
bot.onText(/^\/start(@\w+)?$/, async (msg) => {
  const chatId = msg.chat.id;
  const isGroup = await isGroupChat(chatId);

  if (isGroup) {
    await registerGroup(chatId, msg.chat.title);
    const welcomeMsg = `🤖 *Kanda Freelancer Bot Ativado!*\n\n✅ Sistema de proteção contra links ativado\n✅ Anúncios automáticos configurados\n✅ Painel administrativo disponível\n\nPara mais informações, envie mensagens privadas ao bot!`;
    await sendWithTyping(chatId, welcomeMsg, { parse_mode: 'Markdown', ...groupWelcomeKeyboard() });
  } else {
    await registerUser(msg.from);
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

// ⚠️ Texto de exemplo — substitui pelo conteúdo real da tua política
// de privacidade e termos de uso antes de ires para produção.
const PRIVACY_TEXT = `🔒 *Política de Privacidade e Termos de Uso*\n\n
*1. Dados que recolhemos:*
✅ Nome e nome de utilizador do Telegram
✅ Identificador (ID) de utilizador do Telegram
✅ Mensagens enviadas em privado ao bot\n
*2. Como usamos os seus dados:*
📌 Para responder às suas mensagens
📌 Para lhe enviar anúncios da plataforma
📌 Para gestão de segurança nos grupos (avisos e banimentos por links)\n
*3. Partilha de dados:*
🚫 Não vendemos nem partilhamos os seus dados com terceiros\n
*4. Termos de Uso:*
✋ É proibido publicar links não autorizados nos grupos
✋ Ao usar o bot, concorda com estes termos\n
*Dúvidas sobre os seus dados?*
👤 Contato: @zuacassongo`;

// [FIX] Comando /comofunciona real (com @NomeDoBot opcional em grupo)
bot.onText(/^\/comofunciona(@\w+)?$/, async (msg) => {
  await sendWithTyping(msg.chat.id, HELP_TEXT, { parse_mode: 'Markdown', ...mainMenuKeyboard() });
});

// [FIX] Comando /faladmin real (com @NomeDoBot opcional em grupo)
bot.onText(/^\/faladmin(@\w+)?$/, async (msg) => {
  await sendWithTyping(
    msg.chat.id,
    `👤 Para falar diretamente com o administrador, clica aqui: ${ADMIN_CONTACT}`,
    { parse_mode: 'Markdown' }
  );
});

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

  if (query.data === 'politica_privacidade') {
    await bot.answerCallbackQuery(query.id);
    await sendWithTyping(chatId, PRIVACY_TEXT, { parse_mode: 'Markdown' });
  }
});

// ============================================
// RELAY: CONVERSA PRIVADA <-> ADMIN
// (utilizador escreve, admin responde em privado ao bot
//  respondendo à mensagem encaminhada, sem interromper o fluxo)
//
// [AJUSTE] O utilizador recebe SÓ o texto puro do admin, sem qualquer
// prefixo do tipo "💬 Resposta do Admin:" — para o utilizador, é como se
// fosse uma resposta normal do próprio bot.
// ============================================

async function handleAdminChat(msg) {
  const text = msg.text || '';

  // O admin está a RESPONDER a uma mensagem que o bot encaminhou de um utilizador
  if (msg.reply_to_message) {
    const original = await findPrivateMessageByAdminReply(msg.reply_to_message.message_id);
    if (original) {
      await sendWithTyping(original.userId, text);
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
    await registerUser(msg.from);

    if (text && !text.startsWith('/')) {
      const docId = await logPrivateMessage(msg.from, text, msg.message_id);

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

  // ============================================
  // ---------- DENTRO DE GRUPOS ----------
  // Ordem de verificação (todas independentes umas das outras):
  //   1. Mídia (apagar se o bot for admin; ignorar se não for)
  //   2. LINK — detetado e avisado SEMPRE, seja o bot admin ou não.
  //      Se for admin: apaga a mensagem, conta aviso, pode restringir/banir.
  //      Se não for admin: só avisa o utilizador para remover o link.
  //   3. PALAVRAS-CHAVE — só dispara se o texto NÃO tiver link (para não
  //      dar duas respostas seguidas) e só se houver correspondência exata
  //      com alguma palavra-chave marcada como ativa no painel. Se não
  //      houver correspondência, o bot não responde nada.
  // ============================================
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

    // ---------- 1. DETEÇÃO DE LINK (independente de o bot ser admin) ----------
    if (containsLink(text)) {
      await logLinkDetection(chatId, msg.chat.title, msg.from, text);

      const isBanned = await isUserBanned(chatId, userId);
      if (isBanned) return; // já banido, nada a fazer

      const canModerate = await botCanModerate(chatId);

      if (canModerate) {
        // Bot é admin: apaga a mensagem, conta aviso, pode restringir/banir
        try {
          await bot.deleteMessage(chatId, msg.message_id);
        } catch (error) {
          console.error('Erro ao deletar mensagem com link:', error);
        }

        const warningCount = await addWarning(chatId, userId, userName);

        if (warningCount >= BAN_THRESHOLD) {
          const banned = await banUser(chatId, userId, userName);
          if (banned) {
            await sendWithTyping(
              chatId,
              `⛔ *Usuário Banido*\n\n@${userName} foi removido por publicação repetida de links.`,
              { parse_mode: 'Markdown' }
            );
          } else if (await botCanRestrict(chatId)) {
            await restrictUser(chatId, userId, 60);
            await sendWithTyping(
              chatId,
              `🔇 @${userName} foi restringido por 1 hora após atingir ${BAN_THRESHOLD} avisos por links.`,
              { parse_mode: 'Markdown' }
            );
          }
        } else {
          const warningMsg = await sendWithTyping(
            chatId,
            `⚠️ *Aviso para @${userName}*\n\n🚫 Links não são permitidos aqui! Por favor, remove o link publicado.\n\n❌ Sua mensagem foi removida.\n⚠️ Aviso ${warningCount}/${BAN_THRESHOLD}\n\n⛔ Se receber ${BAN_THRESHOLD} avisos, será banido ou restringido!\n\n📌 Envie mensagens privadas ao bot para sugestões.`,
            { parse_mode: 'Markdown' }
          );
          setTimeout(() => {
            bot.deleteMessage(chatId, warningMsg.message_id).catch(() => {});
          }, 30000);
        }
      } else {
        // Bot NÃO é admin: não pode apagar nem banir, mas AVISA sempre,
        // pedindo ao próprio utilizador para remover o link publicado.
        const warningCount = await addWarning(chatId, userId, userName);
        const warningMsg = await sendWithTyping(
          chatId,
          `⚠️ @${userName}, por favor remove o link que publicaste. Links não são permitidos neste grupo.\n\n⚠️ Aviso ${warningCount}/${BAN_THRESHOLD}`,
          { parse_mode: 'Markdown' }
        );
        setTimeout(() => {
          bot.deleteMessage(chatId, warningMsg.message_id).catch(() => {});
        }, 30000);

        if (warningCount >= BAN_THRESHOLD) {
          await sendWithTyping(
            adminId,
            `⚠️ @${userName} atingiu ${BAN_THRESHOLD} avisos por links no grupo "${msg.chat.title}", mas o bot não é administrador e não pôde remover/banir.`
          );
        }
      }
      return; // link tratado, não verifica palavras-chave na mesma mensagem
    }

    // ---------- 2. PALAVRAS-CHAVE (configuradas no painel) ----------
    const keyword = findKeywordResponse(text);
    if (keyword) {
      await sendWithTyping(chatId, keyword.response, { parse_mode: 'Markdown' });
    }
    // Se não corresponder a nenhuma palavra-chave, o bot não responde nada
    // e segue a rotina normal — não há fallback nem mensagem genérica.
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
💬 Mensagens: ${messagesSnapshot.size}
🔑 Palavras-chave ativas: ${KEYWORDS_CACHE.filter((k) => k.active !== false).length}`;

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
// Configuráveis em settings/ads no Firestore — o painel escreve os horários
// e textos, e o bot reage EM TEMPO REAL (onSnapshot) reagendando os cron
// jobs sem precisar reiniciar. Cada anúncio dispara exatamente na hora
// marcada (conversão "HH:MM" -> expressão cron "minuto hora * * *").
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

// node-schedule NÃO aceita "HH:MM" diretamente — precisa de uma expressão cron
// ("minuto hora * * *") ou de um objeto RecurrenceRule. Passar '06:00' fazia
// scheduleJob() devolver `null` silenciosamente, o que rebentava mais tarde
// em scheduledJobs.forEach(job => job.cancel()).
function timeToCron(time) {
  // Aceita "HH:MM" (24h). Se já vier como cron válido (tem espaços), usa direto.
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
  // cancela jobs anteriores antes de recriar (permite reagendar em tempo real)
  // blindado contra entradas null/undefined que possam ter ficado no array
  scheduledJobs.forEach((job) => {
    if (job && typeof job.cancel === 'function') {
      job.cancel();
    }
  });
  scheduledJobs = [];

  const ads = await getAdsSettings();
  let scheduledCount = 0;

  ads.forEach((ad) => {
    const cronExpression = timeToCron(ad.time);
    if (!cronExpression) return; // horário inválido, já foi logado em timeToCron

    const job = schedule.scheduleJob(cronExpression, async () => {
      console.log(`⏰ A disparar anúncio das ${ad.time}...`);
      const result = await broadcastToAll(ad.text);
      console.log(
        `✅ Anúncio das ${ad.time} enviado — grupos ${result.groupsSent}/${result.groupsTotal}, utilizadores ${result.usersSent}/${result.usersTotal}`
      );
    });

    if (job) {
      scheduledJobs.push(job);
      scheduledCount++;
    } else {
      console.error(`⚠️ Falha ao agendar anúncio das ${ad.time} (expressão cron: "${cronExpression}")`);
    }
  });

  console.log(`✅ ${scheduledCount} anúncios agendados com sucesso`);
}

// Reagenda automaticamente sempre que a configuração de anúncios mudar no Firestore
// (o painel admin edita os horários/textos diretamente na base de dados, e o
// bot aplica em tempo real, sem reiniciar)
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
    // Remove qualquer sessão de polling/webhook residual antes de arrancar,
    // para evitar o erro "409 Conflict: terminated by other getUpdates request"
    // quando o Railway substitui um deploy antigo por um novo.
    await bot.deleteWebHook({ drop_pending_updates: true }).catch(() => {});

    botInfo = await bot.getMe();
    console.log(`🤖 Bot identificado como @${botInfo.username}`);
  } catch (error) {
    console.error('Erro ao obter informações do bot:', error);
  }

  await scheduleAnnouncements();
  watchAdsSettings();
  watchKeywords();

  console.log('🤖 Bot Kanda Freelancer iniciado com sucesso!');
  console.log('✅ Indicador de "digitando..." ativo');
  console.log('✅ Bot só processa texto em grupos (mídia é ignorada/removida)');
  console.log('✅ Deteção de link SEMPRE ativa em grupo (admin ou não)');
  console.log('✅ Sistema de palavras-chave configurável pelo painel (tempo real)');
  console.log('✅ Conversa privada com relay para o admin (responder = reply, sem prefixo)');
  console.log('✅ Anúncios agendados para grupos e utilizadores (hora exata via cron)');
  console.log('');
  console.log('⚠️  IMPORTANTE — Privacy Mode do bot:');
  console.log('   Para o bot conseguir LER texto normal em grupo (deteção de link');
  console.log('   e palavras-chave), o "Group Privacy" no @BotFather tem de estar');
  console.log('   DESATIVADO (/mybots -> [teu bot] -> Bot Settings -> Group Privacy');
  console.log('   -> Turn off). Depois de mudar, remove e volta a adicionar o bot');
  console.log('   ao grupo para a alteração ter efeito. Se o bot for ADMIN do grupo,');
  console.log('   o Telegram já lhe entrega todo o texto mesmo com Privacy ativo —');
  console.log('   mas para grupos onde o bot NÃO é admin, o Privacy Mode TEM de');
  console.log('   estar desativado, senão o bot não vê o texto para detetar links');
  console.log('   nem palavras-chave.');
})();

bot.on('polling_error', (error) => {
  console.error('Erro de polling:', error);
});

module.exports = bot;