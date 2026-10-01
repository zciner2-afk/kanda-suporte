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

// [NOVO] Suporte opcional a Webhook, mantendo o polling como padrão.
// Para ativar o webhook, define USE_WEBHOOK=true nas variáveis de ambiente
// (e RAILWAY_PUBLIC_DOMAIN, que o Railway já injeta automaticamente, ou
// PUBLIC_URL manualmente). Se USE_WEBHOOK não estiver definido (ou for
// "false"), o bot continua a funcionar exatamente como antes, via polling.
//
// RECOMENDAÇÃO: definir USE_WEBHOOK=true no Railway elimina por completo o
// erro "409 Conflict: terminated by other getUpdates request" que acontece
// durante deploys (duas instâncias a fazer polling ao mesmo tempo), e que é
// a causa mais provável de eventos my_chat_member se perderem nalguns
// grupos. Com webhook não há polling, logo não há essa corrida.
const USE_WEBHOOK = String(process.env.USE_WEBHOOK || '').toLowerCase() === 'true';
const WEBHOOK_PATH = `/webhook/${token}`;

// Quando USE_WEBHOOK=true, o bot NÃO faz polling (evita duplicar updates).
// Quando USE_WEBHOOK=false (padrão), comportamento 100% igual ao anterior.
const bot = new TelegramBot(token, { polling: !USE_WEBHOOK });

admin.initializeApp({
  credential: admin.credential.cert(firestoreKey)
});

const db = admin.firestore();

// ============================================
// [SUPER-FIX] REDE DE SEGURANÇA GLOBAL
// ============================================
// Nunca deixar uma rejeição de Promise ou uma exceção não tratada derrubar
// o processo inteiro. Isto é o que estava a causar os crashes em produção
// (ex.: "ETELEGRAM: 400 Bad Request: chat not found" quando o painel manda
// mensagem para um utilizador/grupo que já não existe do lado do Telegram).
// Continuamos a logar o erro para diagnóstico, mas o bot mantém-se de pé.
process.on('unhandledRejection', (reason) => {
  console.error('⚠️  Unhandled Rejection (bot continua a correr):', (reason && reason.message) || reason);
});

process.on('uncaughtException', (error) => {
  console.error('⚠️  Uncaught Exception (bot continua a correr):', (error && error.message) || error);
});

// [SUPER-FIX] Wrapper genérico para handlers do bot (onText, on('message'),
// on('callback_query'), etc.). Garante que qualquer erro dentro do handler
// é apanhado e logado, em vez de propagar como rejeição não tratada.
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

// [AJUSTE-2] Cache em memória dos grupos já confirmados nesta execução do
// processo, para não escrever no Firestore a cada mensagem de grupo (ver
// ensureGroupRegistered mais abaixo). É apenas uma otimização de custo —
// não substitui o Firestore como fonte de verdade.
const registeredGroupIds = new Set();

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
// ou webhook — ver USE_WEBHOOK acima) E para o painel admin poder:
//  - avisar o utilizador que "o admin está a escrever..." (/api/typing)
//  - enviar uma resposta de texto ao utilizador (/api/reply)
//  - gerir palavras-chave, anúncios, trabalhos, banimentos, grupos, etc.
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

// [NOVO] Rota do Webhook do Telegram (só é montada quando USE_WEBHOOK=true).
// Fica ANTES do app.listen, como já era o caso das restantes rotas.
// O path inclui o token para dificultar que terceiros descubram/adivinhem
// o endpoint e enviem updates falsos.
if (USE_WEBHOOK) {
  app.post(WEBHOOK_PATH, (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
  });
}

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
    res.status(500).json({ error: 'Erro ao processar pedido: ' + error.message });
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

// [NOVO] Painel admin: listar grupos ativos com nome e quem adicionou.
// Lê diretamente da coleção `groups`, já enriquecida pelo listener
// `my_chat_member` (ver registerGroupFromChatMember mais abaixo) com
// os campos `title` e `addedByName`, mantendo também os campos antigos
// `name`/`active` para não quebrar nada que já dependa deles.
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

// [NOVO] Painel admin: enviar mensagem só para UM grupo específico
// (equivalente ao tipo `post_group` do dashboard_commands, mas via REST,
// consistente com o resto deste painel).
// [AJUSTE-1] Texto livre do admin: sendWithTyping já tenta Markdown e cai
// para texto simples automaticamente se o parsing falhar (ver definição).
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

// [NOVO] Painel admin: broadcast só para grupos (não afeta utilizadores),
// equivalente ao tipo `post_all_groups`.
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

// [NOVO] Painel admin: listar utilizadores ativos com nome
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

// [NOVO] Painel admin: enviar mensagem só para UM utilizador específico
// (equivalente ao tipo `notify_uid`).
// [AJUSTE-1] Texto livre do admin: mesmo fallback automático de parse_mode.
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

// [NOVO] Painel admin: broadcast só para utilizadores (não afeta grupos),
// equivalente ao tipo `notify_all`.
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

// [SUPER-FIX] Painel admin: reconciliação manual — força o bot a verificar,
// grupo a grupo, se ainda está de facto presente (via getChatMember sobre o
// próprio bot). Corrige grupos "fantasmas" que ficaram com o estado errado
// no Firestore por qualquer motivo (falha pontual, migração não capturada
// a tempo, etc.). Não precisa de correr sempre — é uma ferramenta de
// diagnóstico/correção sob demanda a partir do painel.
app.post('/api/groups/reconcile', requirePanelToken, async (req, res) => {
  try {
    const result = await reconcileGroups();
    res.json({ ok: true, result });
  } catch (error) {
    console.error('Erro ao reconciliar grupos (painel):', error.message);
    res.status(500).json({ error: 'Erro ao reconciliar grupos.' });
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
// Isto resolve o padrão de erro "can't parse entities" que antes derrubava
// o envio a TODOS os grupos/utilizadores de uma vez.
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
// [SUPER-FIX] Agora captura erros do sendMessage, classifica-os e nunca
// deixa uma rejeição "crua" propagar para quem não tem try/catch à volta.
// [AJUSTE-1] Passa a usar sendTextTolerant por baixo, então qualquer
// chamador que passe { parse_mode: 'Markdown' } com texto livre do admin
// (painel, dashboard_commands, etc.) já fica protegido contra o erro
// "can't parse entities" sem precisar de mudar nada nesses chamadores.
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
    // Tenta perceber se é grupo ou utilizador para atualizar o registo certo.
    // Não sabemos ao certo aqui, por isso tentamos os dois silenciosamente.
    await handleSendError(error, 'group', chatId).catch(() => {});
    await handleSendError(error, 'user', chatId).catch(() => {});
    throw error; // quem chamou decide como reagir (ou o safeHandler apanha)
  }
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
    console.error('Erro ao verificar permissões do bot no grupo:', error.message);
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
// que continuam a ser usados pelo resto do bot (broadcastToAll, /api/stats,
// etc.) — os dois esquemas coexistem no mesmo documento.
//
// [SUPER-FIX] O critério de "o bot continua no grupo" passou de uma LISTA
// BRANCA (['member','administrator','creator']) para uma LISTA NEGRA
// (tudo exceto 'left'/'kicked'). Isto é essencial: o Telegram tem outros
// estados possíveis — o mais comum é 'restricted', que acontece quando o
// grupo tem definições que limitam o que bots recém-adicionados podem
// fazer. Com a lista branca antiga, um grupo nesse estado era gravado como
// "removed"/inativo mesmo com o bot LÁ DENTRO — por isso desaparecia do
// painel enquanto continuava a aparecer nos "grupos em comum" do Telegram.
async function registerGroupFromChatMember(upd) {
  try {
    const chat = upd.chat || {};
    const from = upd.from || {};
    const newStatus = upd.new_chat_member && upd.new_chat_member.status;

    // Só consideramos o bot "fora" do grupo se o Telegram disser
    // explicitamente que saiu ou foi expulso. Qualquer outro status
    // (member, administrator, creator, restricted, ou algo novo que o
    // Telegram venha a introduzir no futuro) conta como "ainda presente".
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
        rawStatus: newStatus || null, // guarda o status bruto do Telegram para diagnóstico
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

    // Se o bot ficou "restricted", registamos um aviso separado para o
    // admin perceber que pode ter permissões limitadas nesse grupo,
    // mas sem marcar o grupo como inativo.
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
// perdido (ex.: por causa do erro "409 Conflict: terminated by other
// getUpdates request" durante um deploy no Railway, quando duas instâncias
// do bot competem pelo polling e um update pode não chegar a ser
// processado por nenhuma delas a tempo).
//
// Funciona de forma passiva e barata: sempre que o bot recebe QUALQUER
// mensagem de um grupo, confirma-se (via este helper) que esse grupo está
// marcado como ativo. Para não escrever no Firestore a cada mensagem,
// mantém-se em memória (registeredGroupIds) quais os grupos já confirmados
// nesta execução do processo — só escreve quando o grupo ainda não foi
// visto (grupo novo) ou quando não se sabe se está ativo.
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

// [SUPER-FIX] Reconciliação sob demanda: para cada grupo marcado como ativo
// no Firestore, confirma junto do Telegram (getChatMember do próprio bot)
// se isso ainda é verdade, e corrige o registo se não for. Complementa
// registerGroupFromChatMember para casos em que o evento não chegou a
// tempo (falha pontual de rede, reinício do bot na hora exata, etc.).
async function reconcileGroups() {
  if (!botInfo) return { checked: 0, fixed: 0 };

  const snap = await db.collection('groups').get();
  let checked = 0;
  let fixed = 0;

  for (const doc of snap.docs) {
    const group = doc.data();
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

// [NOVO] Junta um botão "🔙 Voltar ao Menu" a um teclado já existente
// (ou cria um teclado só com esse botão, se nenhum for passado). Usado
// nos textos explicativos (Como Funciona / Política de Privacidade) para
// o utilizador conseguir voltar sem escrever nada. O Telegram não permite
// cor customizada em botões inline — o emoji 🔙 é o destaque possível.
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
// COMANDOS DE GRUPO / GERAIS
// ============================================
// [SUPER-FIX] Todos os handlers abaixo (onText, on('message'),
// on('callback_query')) passam agora por safeHandler(), para que qualquer
// erro dentro deles seja apanhado e logado em vez de derrubar o bot.

// [FIX] Em grupos o Telegram costuma enviar "/start@NomeDoBot" (para
// desambiguar quando há vários bots no grupo). O regex agora aceita ambos:
// "/start" (privado) e "/start@NomeDoBot" (grupo).
bot.onText(/^\/start(@\w+)?$/, safeHandler(async (msg) => {
  const chatId = msg.chat.id;
  const isGroup = isGroupChatType(msg.chat.type);

  if (isGroup) {
    await registerGroup(chatId, msg.chat.title);
    const welcomeMsg = `🤖 *Kanda Freelancer Bot Ativado!*\n\n✅ Sistema de proteção contra links ativado\n✅ Anúncios automáticos configurados\n✅ Painel administrativo disponível\n\nPara mais informações, envie mensagens privadas ao bot!`;
    await sendWithTyping(chatId, welcomeMsg, { parse_mode: 'Markdown', ...groupWelcomeKeyboard() });
  } else {
    await registerUser(msg.from);
    await sendWithTyping(
      chatId,
      `👋 Olá! Bem-vindo(a) à Kanda Freelancer!\n\nSomos a equipa que liga comerciantes a freelancers. 🤝\n\n💼 És freelancer? Fala comigo sobre dúvidas, dificuldades ou como começar.\n🏪 És comerciante? Tens um serviço para publicar? Escreve aqui os detalhes e eu envio ao administrador.\n\n✍️ Podes escrever à vontade — um simples "oi", "olá", uma dúvida, ou o que precisares. Não precisas de usar comandos, eu vejo e respondo tudo por aqui!\n\n👇 Para mais informações, usa os botões abaixo.`,
      mainMenuKeyboard()
    );
  }
}));

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

// ⚠️ Texto de exemplo — substitui pelo conteúdo real da tua política
// de privacidade e termos de uso antes de ires para produção.
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

// [FIX] Comando /comofunciona real (com @NomeDoBot opcional em grupo)
// [AJUSTE] Agora inclui também o botão 🔙 Voltar ao Menu.
bot.onText(/^\/comofunciona(@\w+)?$/, safeHandler(async (msg) => {
  await sendWithTyping(msg.chat.id, HELP_TEXT, { parse_mode: 'Markdown', ...withBackRow(mainMenuKeyboard()) });
}));

// [FIX] Comando /faladmin real (com @NomeDoBot opcional em grupo)
bot.onText(/^\/faladmin(@\w+)?$/, safeHandler(async (msg) => {
  await sendWithTyping(
    msg.chat.id,
    `👤 Para falar diretamente com o administrador, clica aqui: ${ADMIN_CONTACT}`,
    { parse_mode: 'Markdown' }
  );
}));

// [AJUSTE] Agora também inclui o botão 🔙 Voltar ao Menu, para ficar
// consistente com o clique no botão "Como Funciona" do menu.
bot.onText(/\?/, safeHandler(async (msg) => {
  await sendWithTyping(msg.chat.id, HELP_TEXT, { parse_mode: 'Markdown', ...withBackRow(mainMenuKeyboard()) });
}));

// [AJUSTE] Agora também inclui o botão 🔙 Voltar ao Menu, para ficar
// consistente com o clique no botão "Como Funciona" do menu.
bot.onText(/como funciona|como trabaja|como trabalha/i, safeHandler(async (msg) => {
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
// [AJUSTE] 'como_funciona' e 'politica_privacidade' agora incluem o botão
// 🔙 Voltar ao Menu. [NOVO] callback 'go:menu' reenvia o menu principal.
bot.on('callback_query', safeHandler(async (query) => {
  const chatId = query.message.chat.id;

  try {
    await bot.answerCallbackQuery(query.id);
  } catch (error) {
    // botão pode já ter sido respondido / callback expirado — não é crítico
  }

  if (query.data === 'como_funciona') {
    await sendWithTyping(chatId, HELP_TEXT, { parse_mode: 'Markdown', ...withBackRow() });
  }

  if (query.data === 'politica_privacidade') {
    await sendWithTyping(chatId, PRIVACY_TEXT, { parse_mode: 'Markdown', ...withBackRow() });
  }

  if (query.data === 'go:menu') {
    await sendWithTyping(
      chatId,
      `👋 Olá! Bem-vindo(a) à Kanda Freelancer!\n\nSomos a equipa que liga comerciantes a freelancers. 🤝\n\n💼 És freelancer? Fala comigo sobre dúvidas, dificuldades ou como começar.\n🏪 És comerciante? Tens um serviço para publicar? Escreve aqui os detalhes e eu analiso.\n\n✍️ Podes escrever à vontade — um simples "oi", "olá", uma dúvida, ou o que precisares. Não precisas de usar comandos, eu vejo e respondo tudo por aqui!\n\n👇 Para mais informações, usa os botões abaixo.`,
      mainMenuKeyboard()
    );
  }
}));

// ============================================
// RELAY: CONVERSA PRIVADA <-> ADMIN
// (utilizador escreve, admin responde em privado ao bot
//  respondendo à mensagem encaminhada, sem interromper o fluxo)
//
// [AJUSTE] O utilizador recebe SÓ o texto puro do admin, sem qualquer
// prefixo do tipo "💬 Resposta do Admin:" — para o utilizador, é como se
// fosse uma resposta normal do próprio bot.
//
// [SUPER-FIX] Agora com try/catch próprio: se o utilizador de destino já
// não existir (bloqueou o bot, apagou a conta), o admin recebe um aviso
// claro em vez do bot simplesmente crashar.
// ============================================

async function handleAdminChat(msg) {
  const text = msg.text || '';

  // O admin está a RESPONDER a uma mensagem que o bot encaminhou de um utilizador
  if (msg.reply_to_message) {
    const original = await findPrivateMessageByAdminReply(msg.reply_to_message.message_id);
    if (original) {
      try {
        await sendWithTyping(original.userId, text);
        await markPrivateMessageResponded(original.id);
        await bot.sendMessage(msg.chat.id, `✅ Resposta enviada a @${original.userName || original.userId}.`);
      } catch (error) {
        await bot.sendMessage(
          msg.chat.id,
          `⚠️ Não foi possível entregar a resposta a @${original.userName || original.userId} — provavelmente bloqueou o bot ou a conta já não existe. (${error.message})`
        ).catch(() => {});
      }
      return true; // tratado, não continuar
    }
  }

  return false; // não era uma resposta a um utilizador, segue fluxo normal (comandos /admin, etc.)
}

// ============================================
// MENSAGENS GERAIS (PRIVADO, GRUPO, MÍDIA)
// ============================================

bot.on('message', safeHandler(async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const userName = msg.from.username || msg.from.first_name;
  const text = msg.text || '';

  // [SUPER-FIX] Usa o tipo de chat que já vem na própria mensagem, sem
  // chamada extra à API do Telegram.
  const isGroup = isGroupChatType(msg.chat.type);

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

      let sentToAdmin;
      try {
        sentToAdmin = await sendWithTyping(
          adminId,
          `📨 *Mensagem Privada*\n\nDe: @${userName} (${userId})\n\n"${text}"\n\nResponda a ESTA mensagem para falar diretamente com o utilizador.`,
          { parse_mode: 'Markdown' }
        );
      } catch (error) {
        console.error('Erro ao encaminhar mensagem privada para o admin:', error.message);
      }

      if (sentToAdmin) {
        await linkPrivateMessageToAdminMessage(docId, sentToAdmin.message_id);
      }

      try {
        await sendWithTyping(chatId, '✅ Sua mensagem foi recebida! O administrador responderá em breve.');
      } catch (error) {
        console.error(`Não foi possível confirmar receção ao utilizador ${chatId}:`, error.message);
      }
    }
    return;
  }

  // ============================================
  // ---------- DENTRO DE GRUPOS ----------
  // Ordem de verificação (todas independentes umas das outras):
  //   0. [AJUSTE-2] Garante que este grupo está registado/ativo no
  //      Firestore, mesmo que o evento my_chat_member se tenha perdido.
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
    // [AJUSTE-2] Rede de segurança: confirma este grupo como ativo mesmo
    // que o my_chat_member correspondente nunca tenha chegado ao bot.
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
          console.error('Erro ao deletar mensagem com link:', error.message);
        }

        const warningCount = await addWarning(chatId, userId, userName);

        if (warningCount >= BAN_THRESHOLD) {
          const banned = await banUser(chatId, userId, userName);
          if (banned) {
            await sendWithTyping(
              chatId,
              `⛔ *Usuário Banido*\n\n@${userName} foi removido por publicação repetida de links.`,
              { parse_mode: 'Markdown' }
            ).catch(() => {});
          } else if (await botCanRestrict(chatId)) {
            await restrictUser(chatId, userId, 60);
            await sendWithTyping(
              chatId,
              `🔇 @${userName} foi restringido por 1 hora após atingir ${BAN_THRESHOLD} avisos por links.`,
              { parse_mode: 'Markdown' }
            ).catch(() => {});
          }
        } else {
          try {
            const warningMsg = await sendWithTyping(
              chatId,
              `⚠️ *Aviso para @${userName}*\n\n🚫 Links não são permitidos aqui! Por favor, remove o link publicado.\n\n❌ Sua mensagem foi removida.\n⚠️ Aviso ${warningCount}/${BAN_THRESHOLD}\n\n⛔ Se receber ${BAN_THRESHOLD} avisos, será banido ou restringido!\n\n📌 Envie mensagens privadas ao bot para sugestões.`,
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
        // Bot NÃO é admin: não pode apagar nem banir, mas AVISA sempre,
        // pedindo ao próprio utilizador para remover o link publicado.
        const warningCount = await addWarning(chatId, userId, userName);
        try {
          const warningMsg = await sendWithTyping(
            chatId,
            `⚠️ @${userName}, por favor remove o link que publicaste. Links não são permitidos neste grupo.\n\n⚠️ Aviso ${warningCount}/${BAN_THRESHOLD}`,
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
            `⚠️ @${userName} atingiu ${BAN_THRESHOLD} avisos por links no grupo "${msg.chat.title}", mas o bot não é administrador e não pôde remover/banir.`
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
    // Se não corresponder a nenhuma palavra-chave, o bot não responde nada
    // e segue a rotina normal — não há fallback nem mensagem genérica.
  }
}));

// [NOVO] Evento disparado sempre que o status do BOT muda dentro de um
// grupo/canal: quando é adicionado, removido, promovido a admin, etc.
// Regista/atualiza a coleção `groups` com title, type, status, addedBy e
// addedByName, sem substituir a lógica já existente baseada em /start
// (registerGroup continua a ser chamada normalmente lá em cima).
bot.on('my_chat_member', safeHandler(async (upd) => {
  await registerGroupFromChatMember(upd);
}));

// [AJUSTE-2] Rede de segurança adicional: em certas versões/fluxos do
// Telegram, a adição do bot a um grupo chega como uma mensagem de serviço
// com `new_chat_members` (em vez de, ou além de, `my_chat_member`). Se o
// próprio bot aparecer nessa lista, regista o grupo imediatamente — não
// espera pela próxima mensagem de texto de outra pessoa.
bot.on('message', safeHandler(async (msg) => {
  if (!isGroupChatType(msg.chat.type)) return;
  const newMembers = msg.new_chat_members || [];
  if (botInfo && newMembers.some((m) => m.id === botInfo.id)) {
    await ensureGroupRegistered(msg.chat);
    console.log(`👥 [fallback via new_chat_members] Bot adicionado ao grupo "${msg.chat.title || msg.chat.id}".`);
  }
}));

// ============================================
// COMANDOS ADMINISTRATIVOS (via Telegram — sem painel web ainda)
// ============================================

function isAdmin(chatId) {
  return chatId === parseInt(adminId);
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
/messages - Ver mensagens privadas não lidas
/broadcast [texto] - Enviar anúncio a todos os grupos e utilizadores
/stats - Ver estatísticas
/banned - Ver usuários banidos
/unban [groupId] [userId] - Remover banimento
/reconciliar_grupos - Verificar e corrigir grupos "fantasmas"`;

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

// [SUPER-FIX] Comando de conveniência para o admin disparar a reconciliação
// de grupos diretamente pelo Telegram, sem precisar do painel.
bot.onText(/\/reconciliar_grupos/, safeHandler(async (msg) => {
  const chatId = msg.chat.id;
  if (!isAdmin(chatId)) return sendWithTyping(chatId, '❌ Acesso negado.');

  await sendWithTyping(chatId, '🔍 A verificar todos os grupos junto do Telegram...');
  const result = await reconcileGroups();
  await sendWithTyping(
    chatId,
    `✅ Reconciliação concluída.\n🔎 Verificados: ${result.checked}\n🔧 Corrigidos: ${result.fixed}`
  );
}));

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

// [SUPER-FIX] broadcastToAll / broadcastToGroupsOnly / broadcastToUsersOnly
// agora usam handleSendError(), que distingue erro permanente (desativa),
// migração de supergrupo (atualiza o chat_id) e erro transitório (não mexe
// em nada, só regista). Antes, qualquer falha — incluindo rate-limit ou
// timeout momentâneo — marcava logo o destino como inativo.
//
// [AJUSTE-1] Todas as três funções abaixo passaram a usar
// sendTextTolerant() em vez de bot.sendMessage() direto. Isto significa
// que o texto do admin é enviado tentando preservar negrito/itálico
// (Markdown), mas se esse texto tiver formatação mal fechada (ex.: número
// ímpar de "*"), a mensagem NÃO falha — é reenviada automaticamente como
// texto simples para aquele destinatário, e o broadcast continua
// normalmente para todos os outros. É exactamente isto que elimina o
// padrão de erro "can't parse entities" repetido em todos os
// grupos/utilizadores que se via nos logs.
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
      await handleSendError(error, 'group', groupId).catch(() => {});
    }
  }

  for (const doc of usersSnapshot.docs) {
    const userId = doc.data().userId;
    try {
      await sendTextTolerant(userId, text);
      usersSent++;
    } catch (error) {
      console.error(`Erro ao enviar anúncio para utilizador ${userId}:`, error.message);
      await handleSendError(error, 'user', userId).catch(() => {});
    }
  }

  return {
    groupsSent,
    groupsTotal: groupsSnapshot.size,
    usersSent,
    usersTotal: usersSnapshot.size
  };
}

// [NOVO] Envia uma mensagem só para todos os GRUPOS ativos (não afeta
// utilizadores). Equivalente ao tipo `post_all_groups` do dashboard.
// [AJUSTE-1] Usa sendTextTolerant — ver comentário em broadcastToAll.
async function broadcastToGroupsOnly(text) {
  const groupsSnapshot = await db.collection('groups').where('active', '==', true).get();
  let sent = 0;

  for (const doc of groupsSnapshot.docs) {
    const groupId = doc.data().chatId;
    try {
      await sendTextTolerant(groupId, text);
      sent++;
    } catch (error) {
      console.error(`Erro ao enviar mensagem para grupo ${groupId}:`, error.message);
      await handleSendError(error, 'group', groupId).catch(() => {});
    }
  }

  return { sent, total: groupsSnapshot.size };
}

// [NOVO] Envia uma mensagem só para todos os UTILIZADORES ativos (não afeta
// grupos). Equivalente ao tipo `notify_all` do dashboard.
// [AJUSTE-1] Usa sendTextTolerant — ver comentário em broadcastToAll.
async function broadcastToUsersOnly(text) {
  const usersSnapshot = await db.collection('users').where('active', '==', true).get();
  let sent = 0;

  for (const doc of usersSnapshot.docs) {
    const userId = doc.data().userId;
    try {
      await sendTextTolerant(userId, text);
      sent++;
    } catch (error) {
      console.error(`Erro ao enviar mensagem para utilizador ${userId}:`, error.message);
      await handleSendError(error, 'user', userId).catch(() => {});
    }
  }

  return { sent, total: usersSnapshot.size };
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
// [NOVO] dashboard_commands — comandos genéricos gravados pelo painel
// ============================================
// Coleção Firestore: dashboard_commands/{id} = { type, payload, status }
//   type: 'post_group' | 'post_all_groups' | 'notify_uid' | 'notify_all'
//   payload:
//     post_group      -> { chatId, message }
//     post_all_groups -> { message }
//     notify_uid      -> { targetUid, message }
//     notify_all      -> { message }
//   status: 'pending' -> 'done' | 'error' (atualizado pelo próprio bot)
//
// Isto é um canal ADICIONAL de comandos, para painéis que preferem escrever
// diretamente no Firestore em vez de chamar os endpoints REST /api/groups,
// /api/users, etc. (que também foram adicionados acima). Os dois caminhos
// coexistem e produzem o mesmo resultado.
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

(async () => {
  try {
    if (USE_WEBHOOK) {
      // [NOVO] Fluxo de Webhook: resolve o domínio público (Railway já
      // injeta RAILWAY_PUBLIC_DOMAIN automaticamente; PUBLIC_URL serve
      // como override manual, mesmo padrão já usado para SELF_PING_URL
      // noutros projetos) e regista o webhook no Telegram.
      const publicUrl =
        process.env.PUBLIC_URL ||
        (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : null);

      if (!publicUrl) {
        console.error(
          '⚠️ USE_WEBHOOK=true mas nem PUBLIC_URL nem RAILWAY_PUBLIC_DOMAIN estão definidos. A cair para polling como fallback.'
        );
        await bot.deleteWebHook({ drop_pending_updates: true }).catch(() => {});
        await bot.startPolling();
      } else {
        const webhookUrl = `${publicUrl}${WEBHOOK_PATH}`;
        await bot.setWebHook(webhookUrl);
        console.log(`✅ Webhook configurado em ${webhookUrl}`);
      }
    } else {
      // Comportamento original: remove qualquer sessão de polling/webhook
      // residual antes de arrancar, para evitar o erro "409 Conflict:
      // terminated by other getUpdates request" quando o Railway substitui
      // um deploy antigo por um novo.
      await bot.deleteWebHook({ drop_pending_updates: true }).catch(() => {});
    }

    botInfo = await bot.getMe();
    console.log(`🤖 Bot identificado como @${botInfo.username}`);
  } catch (error) {
    console.error('Erro ao obter informações do bot:', error);
  }

  await scheduleAnnouncements();
  watchAdsSettings();
  watchKeywords();
  watchDashboardCommands(); // [NOVO]

  // [SUPER-FIX] Reconciliação automática ao arrancar: corrige qualquer
  // grupo que tenha ficado com o estado errado enquanto o bot esteve
  // offline (reinícios, deploys, quedas momentâneas do Railway, etc.).
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
  }, 5000); // pequeno atraso para dar tempo ao bot.getMe() completar

  console.log('🤖 Bot Kanda Freelancer iniciado com sucesso!');
  console.log(`✅ Modo de recebimento de updates: ${USE_WEBHOOK ? 'WEBHOOK' : 'POLLING'}`);
  console.log('✅ Indicador de "digitando..." ativo');
  console.log('✅ Bot só processa texto em grupos (mídia é ignorada/removida)');
  console.log('✅ Deteção de link SEMPRE ativa em grupo (admin ou não)');
  console.log('✅ Sistema de palavras-chave configurável pelo painel (tempo real)');
  console.log('✅ Conversa privada com relay para o admin (responder = reply, sem prefixo)');
  console.log('✅ Anúncios agendados para grupos e utilizadores (hora exata via cron)');
  console.log('✅ [NOVO] Grupos registados também via my_chat_member (title, status, addedByName)');
  console.log('✅ [NOVO] dashboard_commands (post_group / post_all_groups / notify_uid / notify_all)');
  console.log('✅ [NOVO] Endpoints REST /api/groups e /api/users com envio direcionado');
  console.log('✅ [NOVO] Botão 🔙 Voltar ao Menu nos textos explicativos do bot');
  console.log('✅ [SUPER-FIX] Rede de segurança global contra crashes (unhandledRejection/uncaughtException)');
  console.log('✅ [SUPER-FIX] Deteção de grupo por lista negra (aceita "restricted" e status futuros)');
  console.log('✅ [SUPER-FIX] Migração automática de chat_id quando grupo vira supergrupo');
  console.log('✅ [SUPER-FIX] Reconciliação de grupos (automática no arranque + comando /reconciliar_grupos + /api/groups/reconcile)');
  console.log('✅ [AJUSTE-1] Broadcasts toleram qualquer texto (com ou sem negrito/itálico) sem quebrar em massa');
  console.log('✅ [AJUSTE-2] Qualquer grupo adicionado é capturado mesmo que o evento my_chat_member se perca');
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
  console.log('');
  console.log('ℹ️  Para ativar o Webhook (em vez de polling): define USE_WEBHOOK=true');
  console.log('   nas variáveis de ambiente do Railway. RAILWAY_PUBLIC_DOMAIN já é');
  console.log('   injetado automaticamente pelo Railway; se precisares de um domínio');
  console.log('   diferente, define PUBLIC_URL manualmente (ex.: https://meubot.up.railway.app).');
  console.log('   Recomendado: reduz drasticamente a hipótese de perder eventos');
  console.log('   my_chat_member durante deploys, já que elimina o polling.');
})();

bot.on('polling_error', (error) => {
  console.error('Erro de polling:', error.message);
});

// [NOVO] Erros específicos do webhook (só relevantes quando USE_WEBHOOK=true)
bot.on('webhook_error', (error) => {
  console.error('Erro de webhook:', error.message);
});

module.exports = bot;