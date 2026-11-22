const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { WebSocketServer } = require('ws');
const { db, AVATARS_DIR, BANNERS_DIR, ATTACH_DIR } = require('./db');
const U = require('./utils');

const PORT = Number(process.env.PORT) || 4000;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MAX_AVATAR_BYTES = 5 * 1024 * 1024;
const MAX_BANNER_BYTES = 8 * 1024 * 1024;
const MAX_ATTACH_BYTES = 25 * 1024 * 1024;

const STATIC_FILES = new Map([
  ['/pulse.html', { file: 'pulse.html', type: 'text/html; charset=utf-8' }],
  ['/styles.css', { file: 'styles.css', type: 'text/css; charset=utf-8' }],
  ['/app.js', { file: 'app.js', type: 'application/javascript; charset=utf-8' }],
]);

// --- Security ---
function allowedHosts() {
  const hosts = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`, `[::1]:${PORT}`]);
  const env = String(process.env.ALLOWED_HOSTS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  env.forEach(h => hosts.add(h));
  return hosts;
}
function checkRequestSecurity(req) {
  const host = String(req.headers.host || '').toLowerCase();
  if (!allowedHosts().has(host)) return { ok: false, status: 400, error: 'Bad Host' };
  const origin = req.headers.origin;
  if (origin) {
    try { const o = new URL(origin); if (!allowedHosts().has(o.host.toLowerCase())) return { ok: false, status: 403, error: 'Bad Origin' }; }
    catch { return { ok: false, status: 403, error: 'Bad Origin' }; }
  }
  const sfs = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    if (sfs && !['same-origin', 'same-site', 'none'].includes(sfs)) return { ok: false, status: 403, error: 'Cross-site request blocked' };
  }
  req.clientIP = U.getClientIP(req);
  return { ok: true };
}

// --- DB helpers ---
const stmts = {
  getUserById: db.prepare('SELECT * FROM users WHERE id = ?'),
  getUserByUsername: db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE'),
  getUserByLower: db.prepare('SELECT * FROM users WHERE lower(username) = lower(?)'),
  createUser: db.prepare(`INSERT INTO users (id,username,display_name,password_hash,bio,custom_status,custom_status_emoji,presence,last_seen,avatar_file,avatar_version,banner_file,banner_version,banner_gradient,accent_color,bubble_style,theme,chat_bg,privacy_last_seen,privacy_avatar,privacy_online,is_admin,is_banned,banned_reason,is_premium,premium_until,tag,tag_color,tag_icon,created_at)
    VALUES (@id,@username,@display_name,@password_hash,@bio,@custom_status,@custom_status_emoji,@presence,@last_seen,@avatar_file,@avatar_version,@banner_file,@banner_version,@banner_gradient,@accent_color,@bubble_style,@theme,@chat_bg,@privacy_last_seen,@privacy_avatar,@privacy_online,@is_admin,@is_banned,@banned_reason,@is_premium,@premium_until,@tag,@tag_color,@tag_icon,@created_at)`),
  updateUserProfile: db.prepare(`UPDATE users SET display_name=@display_name, username=@username, bio=@bio, custom_status=@custom_status, custom_status_emoji=@custom_status_emoji WHERE id=@id`),
  updateUserPrefs: db.prepare(`UPDATE users SET accent_color=@accent_color, bubble_style=@bubble_style, theme=@theme, chat_bg=@chat_bg, banner_gradient=@banner_gradient WHERE id=@id`),
  updateUserPrivacy: db.prepare(`UPDATE users SET privacy_last_seen=@privacy_last_seen, privacy_avatar=@privacy_avatar, privacy_online=@privacy_online WHERE id=@id`),
  updatePresence: db.prepare(`UPDATE users SET presence=?, last_seen=? WHERE id=?`),
  setAvatar: db.prepare(`UPDATE users SET avatar_file=?, avatar_version=avatar_version+1 WHERE id=?`),
  clearAvatar: db.prepare(`UPDATE users SET avatar_file=NULL, avatar_version=avatar_version+1 WHERE id=?`),
  setBanner: db.prepare(`UPDATE users SET banner_file=?, banner_version=banner_version+1 WHERE id=?`),
  clearBanner: db.prepare(`UPDATE users SET banner_file=NULL, banner_version=banner_version+1 WHERE id=?`),
  setAdmin: db.prepare('UPDATE users SET is_admin=? WHERE id=?'),
  setBanned: db.prepare('UPDATE users SET is_banned=?, banned_reason=? WHERE id=?'),
  setPremium: db.prepare('UPDATE users SET is_premium=?, premium_until=? WHERE id=?'),
  setTag: db.prepare('UPDATE users SET tag=? WHERE id=?'),
  setTagStyle: db.prepare('UPDATE users SET tag_color=?, tag_icon=? WHERE id=?'),
  listGiftsCatalog: db.prepare('SELECT * FROM gifts_catalog ORDER BY price ASC, name ASC'),
  getGift: db.prepare('SELECT * FROM gifts_catalog WHERE id=?'),
  insertGiftCatalog: db.prepare('INSERT OR IGNORE INTO gifts_catalog (id,emoji,name,price,bg) VALUES (?,?,?,?,?)'),
  sendGift: db.prepare('INSERT INTO user_gifts (id,gift_id,from_user_id,to_user_id,message,created_at) VALUES (?,?,?,?,?,?)'),
  listUserGifts: db.prepare(`SELECT ug.*, gc.emoji, gc.name, gc.price, gc.bg, u.display_name AS from_name, u.username AS from_username
    FROM user_gifts ug JOIN gifts_catalog gc ON gc.id=ug.gift_id JOIN users u ON u.id=ug.from_user_id
    WHERE ug.to_user_id=? ORDER BY ug.created_at DESC LIMIT 100`),
  getUserGift: db.prepare('SELECT * FROM user_gifts WHERE id=?'),
  transferGift: db.prepare('UPDATE user_gifts SET to_user_id=?, transferred_at=? WHERE id=?'),
  listMyGifts: db.prepare(`SELECT ug.*, gc.emoji, gc.name, gc.price, gc.bg, u.display_name AS from_name, u.username AS from_username
    FROM user_gifts ug JOIN gifts_catalog gc ON gc.id=ug.gift_id JOIN users u ON u.id=ug.from_user_id
    WHERE ug.to_user_id=? ORDER BY ug.created_at DESC LIMIT 100`),
  createSession: db.prepare('INSERT INTO sessions (id,user_id,created_at,expires_at) VALUES (?,?,?,?)'),
  getSession: db.prepare('SELECT * FROM sessions WHERE id=?'),
  deleteSession: db.prepare('DELETE FROM sessions WHERE id=?'),
  deleteSessionsByUser: db.prepare('DELETE FROM sessions WHERE user_id=?'),
  cleanSessions: db.prepare('DELETE FROM sessions WHERE expires_at < ?'),
  listUsers: db.prepare('SELECT * FROM users ORDER BY display_name COLLATE NOCASE'),
  createChat: db.prepare('INSERT INTO chats (id,type,title,description,username,avatar_file,avatar_version,created_by,is_public,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)'),
  getChat: db.prepare('SELECT * FROM chats WHERE id=?'),
  getChatByUsername: db.prepare('SELECT * FROM chats WHERE lower(username)=lower(?)'),
  updateChat: db.prepare('UPDATE chats SET title=@title, description=@description, username=@username, is_public=@is_public, updated_at=@updated_at WHERE id=@id'),
  deleteChat: db.prepare('DELETE FROM chats WHERE id=?'),
  addMember: db.prepare('INSERT OR IGNORE INTO chat_members (chat_id,user_id,role,pinned,muted,last_read_message_id,last_read_at,joined_at) VALUES (?,?,?,?,?,?,?,?)'),
  removeMember: db.prepare('DELETE FROM chat_members WHERE chat_id=? AND user_id=?'),
  setMemberRole: db.prepare('UPDATE chat_members SET role=? WHERE chat_id=? AND user_id=?'),
  getMember: db.prepare('SELECT * FROM chat_members WHERE chat_id=? AND user_id=?'),
  listMembers: db.prepare('SELECT cm.*, u.username, u.display_name, u.avatar_file, u.avatar_version, u.presence, u.last_seen, u.custom_status, u.custom_status_emoji, u.privacy_online, u.privacy_last_seen, u.privacy_avatar, u.is_admin, u.is_banned FROM chat_members cm JOIN users u ON u.id=cm.user_id WHERE cm.chat_id=?'),
  listUserChats: db.prepare(`SELECT c.*, cm.role, cm.pinned, cm.muted, cm.last_read_at, cm.last_read_message_id
    FROM chat_members cm JOIN chats c ON c.id=cm.chat_id WHERE cm.user_id=? ORDER BY cm.pinned DESC, c.updated_at DESC`),
  listPublicChats: db.prepare("SELECT * FROM chats WHERE is_public=1 AND type IN ('group','channel') ORDER BY updated_at DESC LIMIT 50"),
  updateChatUpdated: db.prepare('UPDATE chats SET updated_at=? WHERE id=?'),
  createMessage: db.prepare(`INSERT INTO messages (id,chat_id,sender_id,text,reply_to_id,forwarded_from,edited_at,deleted_for_all,created_at) VALUES (@id,@chat_id,@sender_id,@text,@reply_to_id,@forwarded_from,@edited_at,@deleted_for_all,@created_at)`),
  getMessage: db.prepare('SELECT * FROM messages WHERE id=?'),
  listMessages: db.prepare('SELECT * FROM messages WHERE chat_id=? ORDER BY created_at ASC LIMIT ?'),
  updateMessageText: db.prepare('UPDATE messages SET text=?, edited_at=? WHERE id=?'),
  softDeleteForAll: db.prepare("UPDATE messages SET deleted_for_all=1, text='', edited_at=? WHERE id=?"),
  deleteForUser: db.prepare('INSERT OR IGNORE INTO message_deletions (message_id,user_id) VALUES (?,?)'),
  isDeletedForUser: db.prepare('SELECT 1 FROM message_deletions WHERE message_id=? AND user_id=?'),
  addAttachment: db.prepare('INSERT INTO attachments (id,message_id,original_name,mime_type,size,storage_name,kind,created_at) VALUES (?,?,?,?,?,?,?,?)'),
  listAttachments: db.prepare('SELECT * FROM attachments WHERE message_id=?'),
  getAttachment: db.prepare('SELECT * FROM attachments WHERE id=?'),
  addReaction: db.prepare('INSERT OR IGNORE INTO reactions (message_id,user_id,emoji,created_at) VALUES (?,?,?,?)'),
  removeReaction: db.prepare('DELETE FROM reactions WHERE message_id=? AND user_id=? AND emoji=?'),
  listReactions: db.prepare('SELECT emoji, user_id FROM reactions WHERE message_id=?'),
  blockUser: db.prepare('INSERT OR IGNORE INTO blocks (blocker_id,blocked_id,created_at) VALUES (?,?,?)'),
  unblockUser: db.prepare('DELETE FROM blocks WHERE blocker_id=? AND blocked_id=?'),
  isBlocked: db.prepare('SELECT 1 FROM blocks WHERE blocker_id=? AND blocked_id=?'),
  listBlocks: db.prepare('SELECT b.blocked_id, u.username, u.display_name, u.avatar_file, u.avatar_version FROM blocks b JOIN users u ON u.id=b.blocked_id WHERE b.blocker_id=? ORDER BY b.created_at DESC'),
  setRead: db.prepare('UPDATE chat_members SET last_read_message_id=?, last_read_at=? WHERE chat_id=? AND user_id=?'),
  setPinned: db.prepare('UPDATE chat_members SET pinned=? WHERE chat_id=? AND user_id=?'),
  setMuted: db.prepare('UPDATE chat_members SET muted=? WHERE chat_id=? AND user_id=?'),
  countUsers: db.prepare('SELECT COUNT(*) AS c FROM users'),
  countChats: db.prepare('SELECT COUNT(*) AS c FROM chats'),
  countMessages: db.prepare('SELECT COUNT(*) AS c FROM messages'),
};

function getSessionUser(req) {
  const cookies = U.parseCookies(req);
  const sid = cookies.sid;
  if (!sid) return null;
  const s = stmts.getSession.get(sid);
  if (!s) return null;
  if (s.expires_at < U.now()) { stmts.deleteSession.run(sid); return null; }
  const user = stmts.getUserById.get(s.user_id);
  if (!user || user.is_banned) return null;
  return { session: s, user };
}
function requireAdmin(auth, res) {
  if (!auth || !auth.user.is_admin) { U.sendJSON(res, 403, { error: 'Admin access required' }); return false; }
  return true;
}
function requireAuth(req, res) {
  const auth = getSessionUser(req);
  if (!auth) { U.sendJSON(res, 401, { error: 'Unauthorized' }); return null; }
  return auth;
}

function avatarUrl(user) {
  if (!user || !user.avatar_file) return null;
  return `/api/avatar/${encodeURIComponent(user.username)}?v=${user.avatar_version || 1}`;
}
function bannerUrl(user) {
  if (!user || !user.banner_file) return null;
  return `/api/banner/${encodeURIComponent(user.username)}?v=${user.banner_version || 1}`;
}

function canSee(user, viewerId, field) {
  // field: online|last_seen|avatar, privacy_*: all,contacts,nobody
  if (!user) return false;
  if (viewerId && viewerId === user.id) return true;
  const priv = user[`privacy_${field}`] || 'all';
  if (priv === 'all') return true;
  if (priv === 'nobody') return false;
  if (priv === 'contacts') {
    if (!viewerId) return false;
    // contact = share any DM chat
    const row = db.prepare(`SELECT 1 FROM chat_members cm1 JOIN chat_members cm2 ON cm1.chat_id=cm2.chat_id
      JOIN chats c ON c.id=cm1.chat_id WHERE c.type='dm' AND cm1.user_id=? AND cm2.user_id=? LIMIT 1`).get(viewerId, user.id);
    return !!row;
  }
  return true;
}

function publicUser(user, viewerId) {
  const showAvatar = canSee(user, viewerId, 'avatar');
  const showOnline = canSee(user, viewerId, 'online');
  const showLast = canSee(user, viewerId, 'last_seen');
  let presence = user.presence || 'offline';
  if (presence === 'invisible' && viewerId !== user.id) presence = 'offline';
  if (!showOnline && viewerId !== user.id) presence = 'offline';
  return {
    id: user.id,
    username: user.username,
    displayName: user.display_name,
    bio: user.bio || '',
    customStatus: user.custom_status || '',
    customStatusEmoji: user.custom_status_emoji || '',
    presence,
    lastSeen: showLast || viewerId === user.id ? user.last_seen : null,
    avatarUrl: showAvatar ? avatarUrl(user) : null,
    bannerUrl: bannerUrl(user),
    bannerGradient: user.banner_gradient || 'sunset',
    accentColor: user.accent_color || '#5b8cff',
    bubbleStyle: user.bubble_style || 'rounded',
    theme: user.theme || 'dark',
    chatBg: user.chat_bg || 'default',
    isAdmin: !!user.is_admin,
    isBanned: !!user.is_banned,
    isPremium: !!user.is_premium,
    premiumUntil: user.premium_until || 0,
    tag: user.tag || '',
    tagColor: user.tag_color || '#5b8cff',
    tagIcon: user.tag_icon || '',
    bannedReason: viewerId === user.id || (viewerId && stmts.getUserById.get(viewerId)?.is_admin) ? (user.banned_reason || '') : undefined,
    privacy: viewerId === user.id ? {
      lastSeen: user.privacy_last_seen, avatar: user.privacy_avatar, online: user.privacy_online
    } : undefined,
    createdAt: user.created_at,
  };
}

function getChatMembers(chatId) { return stmts.listMembers.all(chatId); }
function isMember(chatId, userId) { return !!stmts.getMember.get(chatId, userId); }

function messagePublic(m, viewerId) {
  const sender = stmts.getUserById.get(m.sender_id);
  const atts = stmts.listAttachments.all(m.id).map(a => ({
    id: a.id, name: a.original_name, type: a.mime_type, size: a.size, kind: a.kind,
    url: `/api/chat/file/${encodeURIComponent(a.id)}`, inline: U.isImageMime(a.mime_type, a.original_name)
  }));
  const reactionsRows = stmts.listReactions.all(m.id);
  const reactions = {};
  for (const r of reactionsRows) { reactions[r.emoji] = reactions[r.emoji] || []; reactions[r.emoji].push(r.user_id); }
  let reply = null;
  if (m.reply_to_id) {
    const rm = stmts.getMessage.get(m.reply_to_id);
    if (rm) {
      const rs = stmts.getUserById.get(rm.sender_id);
      reply = { id: rm.id, text: rm.deleted_for_all ? '' : rm.text, senderName: rs ? rs.display_name : '', deletedForAll: !!rm.deleted_for_all };
    }
  }
  const deletedForViewer = !!stmts.isDeletedForUser.get(m.id, viewerId);
  return {
    id: m.id, chatId: m.chat_id, senderId: m.sender_id,
    sender: sender ? publicUser(sender, viewerId) : null,
    text: m.deleted_for_all ? '' : m.text,
    replyTo: reply,
    forwardedFrom: m.forwarded_from || null,
    editedAt: m.edited_at || null,
    deletedForAll: !!m.deleted_for_all,
    deletedForMe: deletedForViewer,
    createdAt: m.created_at,
    attachments: atts,
    reactions,
  };
}

function chatPublic(chat, viewerId) {
  const members = getChatMembers(chat.id);
  const meMember = members.find(m => m.user_id === viewerId);
  const users = members.map(m => ({ ...publicUser(stmts.getUserById.get(m.user_id), viewerId), role: m.role }));
  let title = chat.title;
  let avatarUrlOut = chat.avatar_file ? `/api/chat-avatar/${encodeURIComponent(chat.id)}?v=${chat.avatar_version || 1}` : null;
  let peer = null;
  if (chat.type === 'dm') {
    const other = members.find(m => m.user_id !== viewerId);
    if (other) {
      const ou = stmts.getUserById.get(other.user_id);
      peer = publicUser(ou, viewerId);
      title = peer.displayName;
      avatarUrlOut = peer.avatarUrl;
    }
  }
  const lastMsg = db.prepare('SELECT * FROM messages WHERE chat_id=? ORDER BY created_at DESC LIMIT 1').get(chat.id);
  const unread = meMember ? db.prepare('SELECT COUNT(*) AS c FROM messages m WHERE m.chat_id=? AND m.created_at > ? AND m.sender_id != ? AND NOT EXISTS (SELECT 1 FROM message_deletions md WHERE md.message_id=m.id AND md.user_id=?)').get(chat.id, meMember.last_read_at || 0, viewerId, viewerId).c : 0;
  const canPost = chat.type !== 'channel' || !meMember || ['owner', 'admin'].includes(meMember.role);
  return {
    id: chat.id, type: chat.type, title, description: chat.description || '',
    username: chat.username || null, isPublic: !!chat.is_public,
    avatarUrl: avatarUrlOut,
    createdAt: chat.created_at, updatedAt: chat.updated_at,
    pinned: !!(meMember && meMember.pinned),
    muted: !!(meMember && meMember.muted),
    myRole: meMember ? meMember.role : null,
    canPost,
    lastReadAt: meMember ? meMember.last_read_at : 0,
    unread,
    members: users,
    peer,
    lastMessage: lastMsg ? messagePublic(lastMsg, viewerId) : null,
  };
}

function ensureDM(userA, userB) {
  const row = db.prepare(`SELECT c.* FROM chats c
    JOIN chat_members m1 ON m1.chat_id=c.id AND m1.user_id=?
    JOIN chat_members m2 ON m2.chat_id=c.id AND m2.user_id=?
    WHERE c.type='dm' LIMIT 1`).get(userA, userB);
  if (row) return row;
  const id = U.uid('c');
  const t = U.now();
  stmts.createChat.run(id, 'dm', null, null, 1, userA, t, t);
  stmts.addMember.run(id, userA, 'member', 0, 0, null, 0, t);
  stmts.addMember.run(id, userB, 'member', 0, 0, null, 0, t);
  return stmts.getChat.get(id);
}

// --- WebSocket ---
const wsClients = new Map(); // userId -> Set<ws>
const typingState = new Map(); // chatId -> Map<userId, timeout>

function wsSend(userId, payload) {
  const set = wsClients.get(userId);
  if (!set) return;
  const data = JSON.stringify(payload);
  for (const ws of set) if (ws.readyState === 1) ws.send(data);
}
function broadcastToChat(chatId, payload, exceptUserId) {
  const members = getChatMembers(chatId);
  for (const m of members) if (m.user_id !== exceptUserId) wsSend(m.user_id, payload);
}
function broadcastPresence(userId) {
  const user = stmts.getUserById.get(userId);
  if (!user) return;
  // notify all users who share any chat
  const rows = db.prepare(`SELECT DISTINCT cm2.user_id as uid FROM chat_members cm1
    JOIN chat_members cm2 ON cm1.chat_id=cm2.chat_id WHERE cm1.user_id=?`).all(userId);
  for (const r of rows) {
    if (r.uid === userId) continue;
    wsSend(r.uid, { type: 'presence', user: publicUser(user, r.uid) });
  }
}

function setupWS(server) {
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname !== '/ws') { socket.destroy(); return; }
    const sec = checkRequestSecurity(req);
    if (!sec.ok) { socket.destroy(); return; }
    const auth = getSessionUser(req);
    if (!auth) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => { ws.user = auth.user; wss.emit('connection', ws, req); });
  });

  wss.on('connection', (ws) => {
    const userId = ws.user.id;
    if (!wsClients.has(userId)) wsClients.set(userId, new Set());
    wsClients.get(userId).add(ws);
    stmts.updatePresence.run(ws.user.presence === 'offline' ? 'online' : ws.user.presence, U.now(), userId);
    broadcastPresence(userId);

    ws.on('message', (buf) => {
      let msg; try { msg = JSON.parse(buf.toString('utf8')); } catch { return; }
      if (msg.type === 'typing') {
        const { chatId, typing } = msg;
        if (!chatId || !isMember(chatId, userId)) return;
        if (!typingState.has(chatId)) typingState.set(chatId, new Map());
        const m = typingState.get(chatId);
        const prev = m.get(userId); if (prev) clearTimeout(prev);
        if (typing) {
          m.set(userId, setTimeout(() => { m.delete(userId); broadcastToChat(chatId, { type: 'typing', chatId, userId, typing: false }); }, 3500));
          broadcastToChat(chatId, { type: 'typing', chatId, userId, typing: true, displayName: ws.user.display_name }, userId);
        } else {
          m.delete(userId);
          broadcastToChat(chatId, { type: 'typing', chatId, userId, typing: false }, userId);
        }
      }
      // WebRTC signaling
      if (['call_offer','call_answer','call_ice','call_end','call_reject','call_busy'].includes(msg.type)) {
        const to = String(msg.to || '');
        if (!to || to === userId) return;
        // only allow signaling between users who share a chat
        const shared = db.prepare('SELECT 1 FROM chat_members a JOIN chat_members b ON a.chat_id=b.chat_id WHERE a.user_id=? AND b.user_id=? LIMIT 1').get(userId, to);
        if (!shared) return;
        const payload = { ...msg, from: userId, fromUser: publicUser(stmts.getUserById.get(userId), to) };
        wsSend(to, payload);
      }
      if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
    });

    ws.on('close', () => {
      const set = wsClients.get(userId);
      if (set) { set.delete(ws); if (!set.size) wsClients.delete(userId); }
      if (!wsClients.has(userId)) {
        stmts.updatePresence.run('offline', U.now(), userId);
        broadcastPresence(userId);
      }
    });
  });
  return wss;
}

// --- Static serving ---
function serveStatic(req, res, pathname) {
  const entry = STATIC_FILES.get(pathname);
  if (!entry) return false;
  const full = path.join(PUBLIC_DIR, entry.file);
  if (!full.startsWith(PUBLIC_DIR)) { U.sendText(res, 403, 'Forbidden'); return true; }
  fs.readFile(full, (err, buf) => {
    if (err) return U.sendText(res, 404, 'Not found');
    U.send(res, 200, buf, { 'Content-Type': entry.type, 'Cache-Control': 'no-cache' });
  });
  return true;
}

// --- Route handlers ---
async function handleRegister(req, res) {
  const body = await U.readJSON(req);
  const displayName = U.sanitizeDisplayName(body.displayName);
  const username = String(body.username || '').trim();
  const usernameLower = U.normalizeUsername(username);
  const password = String(body.password || '');
  if (displayName.length < 2) return U.sendJSON(res, 400, { error: 'Имя должно быть не короче 2 символов' });
  if (!U.validUsername(username)) return U.sendJSON(res, 400, { error: 'Логин: 3-24 символа, латиница, цифры или _' });
  if (password.length < 6) return U.sendJSON(res, 400, { error: 'Пароль должен быть не короче 6 символов' });
  if (stmts.getUserByLower.get(usernameLower)) return U.sendJSON(res, 409, { error: 'Имя пользователя уже занято' });
  const user = {
    id: U.uid('u'), username, display_name: displayName, password_hash: U.hashPassword(password),
    bio: '', custom_status: '', custom_status_emoji: '', presence: 'online', last_seen: U.now(),
    avatar_file: null, avatar_version: 1, banner_file: null, banner_version: 1, banner_gradient: 'sunset',
    accent_color: '#5b8cff', bubble_style: 'rounded', theme: 'dark', chat_bg: 'default',
    privacy_last_seen: 'all', privacy_avatar: 'all', privacy_online: 'all',
    is_admin: 0, is_banned: 0, banned_reason: '', is_premium: 0, premium_until: 0, tag: '', tag_color: '#5b8cff', tag_icon: '', created_at: U.now()
  };
  stmts.createUser.run(user);
  const sid = U.uid('s');
  stmts.createSession.run(sid, user.id, U.now(), U.now() + 30 * 24 * 3600 * 1000);
  U.setCookie(res, 'sid', sid, { maxAge: 30 * 24 * 3600 });
  U.sendJSON(res, 201, { user: publicUser(user, user.id) });
}

async function handleLogin(req, res) {
  const body = await U.readJSON(req);
  const usernameLower = U.normalizeUsername(body.username);
  const password = String(body.password || '');
  const user = stmts.getUserByLower.get(usernameLower);
  if (!user || !U.verifyPassword(password, user.password_hash)) return U.sendJSON(res, 401, { error: 'Неверный логин или пароль' });
  if (user.is_banned) return U.sendJSON(res, 403, { error: 'Аккаунт заблокирован' + (user.banned_reason ? ': ' + user.banned_reason : '') });
  const sid = U.uid('s');
  stmts.createSession.run(sid, user.id, U.now(), U.now() + 30 * 24 * 3600 * 1000);
  stmts.updatePresence.run(user.presence === 'offline' ? 'online' : user.presence, U.now(), user.id);
  U.setCookie(res, 'sid', sid, { maxAge: 30 * 24 * 3600 });
  U.sendJSON(res, 200, { user: publicUser(stmts.getUserById.get(user.id), user.id) });
}

function handleLogout(req, res) {
  const cookies = U.parseCookies(req);
  if (cookies.sid) {
    const s = stmts.getSession.get(cookies.sid);
    if (s) {
      stmts.deleteSession.run(cookies.sid);
      if (!wsClients.has(s.user_id)) stmts.updatePresence.run('offline', U.now(), s.user_id);
    }
  }
  U.clearCookie(res, 'sid');
  U.sendJSON(res, 200, { ok: true });
}

function handleMe(req, res, auth) {
  U.sendJSON(res, 200, { user: publicUser(auth.user, auth.user.id) });
}

async function handlePatchMe(req, res, auth) {
  const body = await U.readJSON(req);
  const user = auth.user;
  if (body.profile) {
    const p = body.profile;
    const displayName = U.sanitizeDisplayName(p.displayName ?? user.display_name);
    const username = String(p.username ?? user.username).trim();
    const usernameLower = U.normalizeUsername(username);
    const bio = String(p.bio ?? user.bio).slice(0, 200);
    const customStatus = String(p.customStatus ?? user.custom_status).slice(0, 60);
    const customStatusEmoji = String(p.customStatusEmoji ?? user.custom_status_emoji).slice(0, 8);
    if (displayName.length < 2) return U.sendJSON(res, 400, { error: 'Имя слишком короткое' });
    if (!U.validUsername(username)) return U.sendJSON(res, 400, { error: 'Некорректный username' });
    const other = stmts.getUserByLower.get(usernameLower);
    if (other && other.id !== user.id) return U.sendJSON(res, 409, { error: 'Username уже занят' });
    stmts.updateUserProfile.run({ id: user.id, display_name: displayName, username, bio, custom_status: customStatus, custom_status_emoji: customStatusEmoji });
  }
  if (body.preferences) {
    const p = body.preferences;
    const accent = /^#[0-9a-fA-F]{6}$/.test(p.accentColor || '') ? p.accentColor : user.accent_color;
    const bubbleStyle = ['rounded', 'sharp', 'minimal'].includes(p.bubbleStyle) ? p.bubbleStyle : user.bubble_style;
    const theme = ['light', 'dark', 'system'].includes(p.theme) ? p.theme : user.theme;
    const chatBg = String(p.chatBg || user.chat_bg).slice(0, 40);
    const bannerGradient = String(p.bannerGradient || user.banner_gradient).slice(0, 40);
    stmts.updateUserPrefs.run({ id: user.id, accent_color: accent, bubble_style: bubbleStyle, theme, chat_bg: chatBg, banner_gradient: bannerGradient });
  }
  if (body.privacy) {
    const p = body.privacy;
    const allowed = ['all', 'contacts', 'nobody'];
    stmts.updateUserPrivacy.run({
      id: user.id,
      privacy_last_seen: allowed.includes(p.lastSeen) ? p.lastSeen : user.privacy_last_seen,
      privacy_avatar: allowed.includes(p.avatar) ? p.avatar : user.privacy_avatar,
      privacy_online: allowed.includes(p.online) ? p.online : user.privacy_online,
    });
  }
  if (body.presence) {
    const allowed = ['online', 'dnd', 'away', 'invisible'];
    if (allowed.includes(body.presence)) stmts.updatePresence.run(body.presence, U.now(), user.id);
  }
  const updated = stmts.getUserById.get(user.id);
  broadcastPresence(user.id);
  U.sendJSON(res, 200, { user: publicUser(updated, user.id) });
}

function handleUsers(req, res, auth) {
  const users = stmts.listUsers.all().filter(u => u.id !== auth.user.id).map(u => publicUser(u, auth.user.id));
  U.sendJSON(res, 200, { users });
}

function handleChats(req, res, auth) {
  const rows = stmts.listUserChats.all(auth.user.id);
  const chats = rows.map(c => chatPublic(c, auth.user.id));
  U.sendJSON(res, 200, { chats });
}

async function handleCreateChat(req, res, auth) {
  const body = await U.readJSON(req);
  if (body.type === 'dm') {
    const username = U.normalizeUsername(body.username);
    const other = stmts.getUserByLower.get(username);
    if (!other) return U.sendJSON(res, 404, { error: 'Пользователь не найден' });
    if (other.id === auth.user.id) return U.sendJSON(res, 400, { error: 'Нельзя создать чат с собой' });
    const blocked = stmts.isBlocked.get(auth.user.id, other.id) || stmts.isBlocked.get(other.id, auth.user.id);
    if (blocked) return U.sendJSON(res, 403, { error: 'Чат недоступен' });
    const chat = ensureDM(auth.user.id, other.id);
    return U.sendJSON(res, 201, { chat: chatPublic(chat, auth.user.id) });
  }
  if (body.type === 'group' || body.type === 'channel') {
    const title = U.sanitizeDisplayName(body.title || '').slice(0, 60);
    if (title.length < 2) return U.sendJSON(res, 400, { error: 'Название слишком короткое' });
    const description = U.sanitizeText(body.description || '', 300);
    const rawUn = String(body.username || '').trim();
    const chatUsername = rawUn ? U.normalizeUsername(rawUn) : null;
    if (chatUsername && !U.validUsername(chatUsername)) return U.sendJSON(res, 400, { error: 'Некорректный username канала/группы' });
    if (chatUsername && (stmts.getChatByUsername.get(chatUsername) || stmts.getUserByLower.get(chatUsername))) return U.sendJSON(res, 409, { error: 'Username уже занят' });
    const isPublic = body.isPublic ? 1 : 0;
    const memberUsernames = Array.isArray(body.members) ? body.members : [];
    const memberIds = new Set([auth.user.id]);
    for (const un of memberUsernames) {
      const u = stmts.getUserByLower.get(U.normalizeUsername(un));
      if (u) memberIds.add(u.id);
    }
    const id = U.uid('c'); const t = U.now();
    stmts.createChat.run(id, body.type, title, description, chatUsername, null, 1, auth.user.id, isPublic, t, t);
    for (const uid of memberIds) stmts.addMember.run(id, uid, uid === auth.user.id ? 'owner' : 'member', 0, 0, null, 0, t);
    const chat = stmts.getChat.get(id);
    for (const uid of memberIds) wsSend(uid, { type: 'chat_created', chat: chatPublic(chat, uid) });
    return U.sendJSON(res, 201, { chat: chatPublic(chat, auth.user.id) });
  }
  U.sendJSON(res, 400, { error: 'Invalid chat type' });
}

function handleGetChat(req, res, auth, chatId) {
  const chat = stmts.getChat.get(chatId);
  if (!chat || !isMember(chatId, auth.user.id)) return U.sendJSON(res, 404, { error: 'Chat not found' });
  const msgs = stmts.listMessages.all(chatId, 200).filter(m => !stmts.isDeletedForUser.get(m.id, auth.user.id));
  U.sendJSON(res, 200, { chat: chatPublic(chat, auth.user.id), messages: msgs.map(m => messagePublic(m, auth.user.id)) });
}

function handleDiscover(req, res, auth) {
  const chats = stmts.listPublicChats.all().filter(c => !isMember(c.id, auth.user.id)).map(c => chatPublic(c, auth.user.id));
  U.sendJSON(res, 200, { chats });
}

async function handleJoinChat(req, res, auth, chatId) {
  const chat = stmts.getChat.get(chatId);
  if (!chat) return U.sendJSON(res, 404, { error: 'Chat not found' });
  if (!chat.is_public && chat.type === 'group') return U.sendJSON(res, 403, { error: 'Группа приватная' });
  if (isMember(chatId, auth.user.id)) return U.sendJSON(res, 200, { chat: chatPublic(chat, auth.user.id) });
  stmts.addMember.run(chatId, auth.user.id, 'member', 0, 0, null, 0, U.now());
  const updated = stmts.getChat.get(chatId);
  for (const m of getChatMembers(chatId)) wsSend(m.user_id, { type: 'chat_updated', chat: chatPublic(updated, m.user_id) });
  U.sendJSON(res, 200, { chat: chatPublic(updated, auth.user.id) });
}

async function handleLeaveChat(req, res, auth, chatId) {
  const chat = stmts.getChat.get(chatId);
  if (!chat || !isMember(chatId, auth.user.id)) return U.sendJSON(res, 404, { error: 'Chat not found' });
  if (chat.type === 'dm') return U.sendJSON(res, 400, { error: 'Нельзя покинуть личный чат' });
  stmts.removeMember.run(chatId, auth.user.id);
  for (const m of getChatMembers(chatId)) wsSend(m.user_id, { type: 'chat_updated', chat: chatPublic(chat, m.user_id) });
  wsSend(auth.user.id, { type: 'chat_left', chatId });
  U.sendJSON(res, 200, { ok: true });
}

async function handleUpdateChat(req, res, auth, chatId) {
  const chat = stmts.getChat.get(chatId);
  if (!chat || !isMember(chatId, auth.user.id)) return U.sendJSON(res, 404, { error: 'Chat not found' });
  const me = stmts.getMember.get(chatId, auth.user.id);
  if (!['owner','admin'].includes(me.role) && !auth.user.is_admin) return U.sendJSON(res, 403, { error: 'Недостаточно прав' });
  const body = await U.readJSON(req);
  const title = U.sanitizeDisplayName(body.title ?? chat.title ?? '').slice(0, 60);
  const description = U.sanitizeText(body.description ?? chat.description ?? '', 300);
  const rawUn = body.username !== undefined ? String(body.username || '').trim() : (chat.username || '');
  const username = rawUn ? U.normalizeUsername(rawUn) : null;
  if (username && !U.validUsername(username)) return U.sendJSON(res, 400, { error: 'Некорректный username' });
  if (username) { const ex = stmts.getChatByUsername.get(username); if (ex && ex.id !== chatId) return U.sendJSON(res, 409, { error: 'Username занят' }); }
  const isPublic = body.isPublic === undefined ? chat.is_public : (body.isPublic ? 1 : 0);
  stmts.updateChat.run({ id: chatId, title, description, username, is_public: isPublic, updated_at: U.now() });
  const updated = stmts.getChat.get(chatId);
  for (const m of getChatMembers(chatId)) wsSend(m.user_id, { type: 'chat_updated', chat: chatPublic(updated, m.user_id) });
  U.sendJSON(res, 200, { chat: chatPublic(updated, auth.user.id) });
}

async function handleAddMember(req, res, auth, chatId) {
  const chat = stmts.getChat.get(chatId);
  if (!chat || !isMember(chatId, auth.user.id)) return U.sendJSON(res, 404, { error: 'Chat not found' });
  const me = stmts.getMember.get(chatId, auth.user.id);
  if (!['owner','admin'].includes(me.role) && !auth.user.is_admin) return U.sendJSON(res, 403, { error: 'Недостаточно прав' });
  const body = await U.readJSON(req);
  const u = stmts.getUserByLower.get(U.normalizeUsername(body.username));
  if (!u) return U.sendJSON(res, 404, { error: 'Пользователь не найден' });
  stmts.addMember.run(chatId, u.id, 'member', 0, 0, null, 0, U.now());
  const updated = stmts.getChat.get(chatId);
  wsSend(u.id, { type: 'chat_created', chat: chatPublic(updated, u.id) });
  for (const m of getChatMembers(chatId)) wsSend(m.user_id, { type: 'chat_updated', chat: chatPublic(updated, m.user_id) });
  U.sendJSON(res, 200, { ok: true });
}

async function handleRemoveMember(req, res, auth, chatId, userId) {
  const chat = stmts.getChat.get(chatId);
  if (!chat || !isMember(chatId, auth.user.id)) return U.sendJSON(res, 404, { error: 'Chat not found' });
  const me = stmts.getMember.get(chatId, auth.user.id);
  if (!['owner','admin'].includes(me.role) && !auth.user.is_admin) return U.sendJSON(res, 403, { error: 'Недостаточно прав' });
  if (userId === chat.created_by) return U.sendJSON(res, 400, { error: 'Нельзя удалить владельца' });
  stmts.removeMember.run(chatId, userId);
  wsSend(userId, { type: 'chat_left', chatId });
  const updated = stmts.getChat.get(chatId);
  for (const m of getChatMembers(chatId)) wsSend(m.user_id, { type: 'chat_updated', chat: chatPublic(updated, m.user_id) });
  U.sendJSON(res, 200, { ok: true });
}

function handleAdminStats(req, res, auth) {
  if (!requireAdmin(auth, res)) return;
  U.sendJSON(res, 200, { stats: { users: stmts.countUsers.get().c, chats: stmts.countChats.get().c, messages: stmts.countMessages.get().c } });
}

function handleAdminUsers(req, res, auth) {
  if (!requireAdmin(auth, res)) return;
  U.sendJSON(res, 200, { users: stmts.listUsers.all().map(u => publicUser(u, auth.user.id)) });
}

async function handleAdminSetRole(req, res, auth) {
  if (!requireAdmin(auth, res)) return;
  const body = await U.readJSON(req);
  const u = stmts.getUserByLower.get(U.normalizeUsername(body.username));
  if (!u) return U.sendJSON(res, 404, { error: 'Пользователь не найден' });
  if (u.username.toLowerCase() === 'kompotmik2') return U.sendJSON(res, 400, { error: 'Нельзя изменить роль главного администратора' });
  stmts.setAdmin.run(body.isAdmin ? 1 : 0, u.id);
  U.sendJSON(res, 200, { user: publicUser(stmts.getUserById.get(u.id), auth.user.id) });
}


async function handleAdminTag(req, res, auth) {
  if (!requireAdmin(auth, res)) return;
  const body = await U.readJSON(req);
  const u = stmts.getUserByLower.get(U.normalizeUsername(body.username));
  if (!u) return U.sendJSON(res, 404, { error: 'Пользователь не найден' });
  const tag = U.sanitizeText(body.tag || '', 24).replace(/[^a-zA-Z0-9_а-яА-ЯёЁ-]/g,'').slice(0,20);
  const color = typeof sanitizeTagColor === 'function' ? sanitizeTagColor(body.color) : (body.color || '#5b8cff');
  const icon = typeof sanitizeTagIcon === 'function' ? sanitizeTagIcon(body.icon) : (body.icon || '');
  stmts.setTag.run(tag, u.id);
  if (stmts.setTagStyle) stmts.setTagStyle.run(color, icon, u.id);
  U.sendJSON(res, 200, { user: publicUser(stmts.getUserById.get(u.id), auth.user.id) });
}
async function handleAdminBan(req, res, auth) {
  if (!requireAdmin(auth, res)) return;
  const body = await U.readJSON(req);
  const u = stmts.getUserByLower.get(U.normalizeUsername(body.username));
  if (!u) return U.sendJSON(res, 404, { error: 'Пользователь не найден' });
  if (u.username.toLowerCase() === 'kompotmik2') return U.sendJSON(res, 400, { error: 'Нельзя заблокировать главного администратора' });
  const banned = body.banned ? 1 : 0;
  const reason = U.sanitizeText(body.reason || '', 200);
  stmts.setBanned.run(banned, reason, u.id);
  if (banned) stmts.deleteSessionsByUser.run(u.id);
  U.sendJSON(res, 200, { user: publicUser(stmts.getUserById.get(u.id), auth.user.id) });
}

function handleAdminChats(req, res, auth) {
  if (!requireAdmin(auth, res)) return;
  const chats = db.prepare('SELECT * FROM chats ORDER BY updated_at DESC LIMIT 200').all().map(c => chatPublic(c, auth.user.id));
  U.sendJSON(res, 200, { chats });
}

async function handleAdminDeleteChat(req, res, auth, chatId) {
  if (!requireAdmin(auth, res)) return;
  const chat = stmts.getChat.get(chatId);
  if (!chat) return U.sendJSON(res, 404, { error: 'Chat not found' });
  const members = getChatMembers(chatId);
  stmts.deleteChat.run(chatId);
  for (const m of members) wsSend(m.user_id, { type: 'chat_left', chatId });
  U.sendJSON(res, 200, { ok: true });
}

async function handlePostMessage(req, res, auth, chatId) {
  const chat = stmts.getChat.get(chatId);
  if (!chat || !isMember(chatId, auth.user.id)) return U.sendJSON(res, 404, { error: 'Chat not found' });
  const member = stmts.getMember.get(chatId, auth.user.id);
  if (chat.type === 'channel' && !['owner', 'admin'].includes(member.role)) return U.sendJSON(res, 403, { error: 'Только администраторы канала могут публиковать' });
  const body = await U.readJSON(req);
  const text = U.sanitizeText(body.text, 4000);
  if (!text) return U.sendJSON(res, 400, { error: 'Текст сообщения пуст' });
  const replyToId = body.replyToId ? String(body.replyToId) : null;
  if (replyToId) {
    const rm = stmts.getMessage.get(replyToId);
    if (!rm || rm.chat_id !== chatId) return U.sendJSON(res, 400, { error: 'Invalid reply' });
  }
  if (chat.type === 'dm') {
    const other = getChatMembers(chatId).find(m => m.user_id !== auth.user.id);
    if (other && (stmts.isBlocked.get(auth.user.id, other.user_id) || stmts.isBlocked.get(other.user_id, auth.user.id))) {
      return U.sendJSON(res, 403, { error: 'Отправка недоступна' });
    }
  }
  const msg = { id: U.uid('m'), chat_id: chatId, sender_id: auth.user.id, text, reply_to_id: replyToId, forwarded_from: body.forwardedFrom ? String(body.forwardedFrom).slice(0, 60) : null, edited_at: null, deleted_for_all: 0, created_at: U.now() };
  stmts.createMessage.run(msg);
  stmts.updateChatUpdated.run(msg.created_at, chatId);
  for (const m of getChatMembers(chatId)) wsSend(m.user_id, { type: 'message', chatId, message: messagePublic(msg, m.user_id) });
  U.sendJSON(res, 201, { message: messagePublic(msg, auth.user.id) });
}

async function handleEditMessage(req, res, auth, msgId) {
  const msg = stmts.getMessage.get(msgId);
  if (!msg) return U.sendJSON(res, 404, { error: 'Not found' });
  if (msg.sender_id !== auth.user.id) return U.sendJSON(res, 403, { error: 'Forbidden' });
  if (msg.deleted_for_all) return U.sendJSON(res, 400, { error: 'Message deleted' });
  const body = await U.readJSON(req);
  const text = U.sanitizeText(body.text, 4000);
  if (!text) return U.sendJSON(res, 400, { error: 'Пустой текст' });
  stmts.updateMessageText.run(text, U.now(), msgId);
  const updated = stmts.getMessage.get(msgId);
  for (const m of getChatMembers(msg.chat_id)) wsSend(m.user_id, { type: 'message_updated', chatId: msg.chat_id, message: messagePublic(updated, m.user_id) });
  U.sendJSON(res, 200, { message: messagePublic(updated, auth.user.id) });
}

async function handleDeleteMessage(req, res, auth, msgId, urlObj) {
  const msg = stmts.getMessage.get(msgId);
  if (!msg) return U.sendJSON(res, 404, { error: 'Not found' });
  if (!isMember(msg.chat_id, auth.user.id)) return U.sendJSON(res, 403, { error: 'Forbidden' });
  const forAll = urlObj.searchParams.get('forAll') === '1';
  if (forAll) {
    if (msg.sender_id !== auth.user.id) return U.sendJSON(res, 403, { error: 'Forbidden' });
    stmts.softDeleteForAll.run(U.now(), msgId);
    const updated = stmts.getMessage.get(msgId);
    for (const m of getChatMembers(msg.chat_id)) wsSend(m.user_id, { type: 'message_updated', chatId: msg.chat_id, message: messagePublic(updated, m.user_id) });
  } else {
    stmts.deleteForUser.run(msgId, auth.user.id);
    wsSend(auth.user.id, { type: 'message_deleted_for_me', chatId: msg.chat_id, messageId: msgId });
  }
  U.sendJSON(res, 200, { ok: true });
}

async function handleReact(req, res, auth, msgId) {
  const msg = stmts.getMessage.get(msgId);
  if (!msg || !isMember(msg.chat_id, auth.user.id)) return U.sendJSON(res, 404, { error: 'Not found' });
  const body = await U.readJSON(req);
  const emoji = String(body.emoji || '').slice(0, 8);
  if (!emoji) return U.sendJSON(res, 400, { error: 'Emoji required' });
  const exists = db.prepare('SELECT 1 FROM reactions WHERE message_id=? AND user_id=? AND emoji=?').get(msgId, auth.user.id, emoji);
  if (exists) stmts.removeReaction.run(msgId, auth.user.id, emoji);
  else stmts.addReaction.run(msgId, auth.user.id, emoji, U.now());
  const updated = stmts.getMessage.get(msgId);
  for (const m of getChatMembers(msg.chat_id)) wsSend(m.user_id, { type: 'message_updated', chatId: msg.chat_id, message: messagePublic(updated, m.user_id) });
  U.sendJSON(res, 200, { ok: true });
}

async function handleRead(req, res, auth, chatId) {
  if (!isMember(chatId, auth.user.id)) return U.sendJSON(res, 404, { error: 'Not found' });
  const body = await U.readJSON(req);
  const msgId = body.messageId || null;
  stmts.setRead.run(msgId, U.now(), chatId, auth.user.id);
  broadcastToChat(chatId, { type: 'read', chatId, userId: auth.user.id, messageId: msgId, at: U.now() });
  U.sendJSON(res, 200, { ok: true });
}

async function handlePinMute(req, res, auth, chatId) {
  if (!isMember(chatId, auth.user.id)) return U.sendJSON(res, 404, { error: 'Not found' });
  const body = await U.readJSON(req);
  if (typeof body.pinned === 'boolean') stmts.setPinned.run(body.pinned ? 1 : 0, chatId, auth.user.id);
  if (typeof body.muted === 'boolean') stmts.setMuted.run(body.muted ? 1 : 0, chatId, auth.user.id);
  U.sendJSON(res, 200, { ok: true });
}

// --- File uploads ---
async function handlePostChatFile(req, res, auth) {
  const chatId = String(req.headers['x-chat-id'] || '').trim();
  const text = U.sanitizeText(decodeURIComponent(String(req.headers['x-chat-text'] || '')), 4000);
  const replyToId = String(req.headers['x-reply-to'] || '').trim() || null;
  const fileName = U.safeFilename(decodeURIComponent(String(req.headers['x-file-name'] || 'upload.bin')));
  const fileType = String(req.headers['x-file-type'] || 'application/octet-stream').slice(0, 128);
  const kind = ['image', 'file', 'voice'].includes(req.headers['x-file-kind']) ? req.headers['x-file-kind'] : (U.isImageMime(fileType, fileName) ? 'image' : 'file');
  const chat = stmts.getChat.get(chatId);
  if (!chat || !isMember(chatId, auth.user.id)) return U.sendJSON(res, 404, { error: 'Chat not found' });
  const member = stmts.getMember.get(chatId, auth.user.id);
  if (chat.type === 'channel' && !['owner', 'admin'].includes(member.role)) return U.sendJSON(res, 403, { error: 'Только администраторы канала могут публиковать' });
  if (replyToId) { const rm = stmts.getMessage.get(replyToId); if (!rm || rm.chat_id !== chatId) return U.sendJSON(res, 400, { error: 'Invalid reply' }); }
  const body = await U.readBody(req, MAX_ATTACH_BYTES);
  if (!body.length) return U.sendJSON(res, 400, { error: 'Empty file' });
  if (body.length > MAX_ATTACH_BYTES) return U.sendJSON(res, 413, { error: 'File too large' });
  const fileId = U.uid('f');
  const storageName = fileId;
  fs.writeFileSync(path.join(ATTACH_DIR, storageName), body);
  const msg = { id: U.uid('m'), chat_id: chatId, sender_id: auth.user.id, text, reply_to_id: replyToId, forwarded_from: null, edited_at: null, deleted_for_all: 0, created_at: U.now() };
  stmts.createMessage.run(msg);
  stmts.addAttachment.run(fileId, msg.id, fileName, fileType, body.length, storageName, kind, U.now());
  stmts.updateChatUpdated.run(msg.created_at, chatId);
  for (const m of getChatMembers(chatId)) wsSend(m.user_id, { type: 'message', chatId, message: messagePublic(msg, m.user_id) });
  U.sendJSON(res, 201, { message: messagePublic(msg, auth.user.id) });
}

function handleGetChatFile(req, res, auth, fileId) {
  const file = stmts.getAttachment.get(fileId);
  if (!file) return U.sendText(res, 404, 'Not found');
  const msg = stmts.getMessage.get(file.message_id);
  if (!msg || !isMember(msg.chat_id, auth.user.id)) return U.sendText(res, 403, 'Forbidden');
  const full = path.join(ATTACH_DIR, file.storage_name);
  if (!fs.existsSync(full)) return U.sendText(res, 404, 'Not found');
  const buf = fs.readFileSync(full);
  const inline = U.isImageMime(file.mime_type, file.original_name);
  U.send(res, 200, buf, {
    'Content-Type': file.mime_type || 'application/octet-stream',
    'Content-Disposition': U.contentDisposition(file.original_name, inline),
    'Cache-Control': 'private, max-age=31536000, immutable',
  });
}

// --- Avatar/Banner ---
function handleGetAvatar(req, res, nick) {
  const user = stmts.getUserByLower.get(U.normalizeUsername(nick));
  if (!user || !user.avatar_file) return U.sendText(res, 404, 'Not found');
  const full = path.join(AVATARS_DIR, user.avatar_file);
  if (!fs.existsSync(full)) return U.sendText(res, 404, 'Not found');
  const ext = path.extname(full).toLowerCase();
  U.send(res, 200, fs.readFileSync(full), { 'Content-Type': mimeFromExt(ext), 'Cache-Control': 'public, max-age=31536000, immutable' });
}
function handleGetBanner(req, res, nick) {
  const user = stmts.getUserByLower.get(U.normalizeUsername(nick));
  if (!user || !user.banner_file) return U.sendText(res, 404, 'Not found');
  const full = path.join(BANNERS_DIR, user.banner_file);
  if (!fs.existsSync(full)) return U.sendText(res, 404, 'Not found');
  const ext = path.extname(full).toLowerCase();
  U.send(res, 200, fs.readFileSync(full), { 'Content-Type': mimeFromExt(ext), 'Cache-Control': 'public, max-age=31536000, immutable' });
}
function mimeFromExt(ext) { return ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }[ext] || 'application/octet-stream'); }

async function handlePostAvatar(req, res, auth, nick) {
  if (auth.user.username.toLowerCase() !== U.normalizeUsername(nick)) return U.sendJSON(res, 403, { error: 'Forbidden' });
  const name = U.safeFilename(decodeURIComponent(String(req.headers['x-file-name'] || 'avatar.png')));
  const type = String(req.headers['x-file-type'] || 'image/png');
  if (!U.isAllowedAvatar(type, name)) return U.sendJSON(res, 400, { error: 'Разрешены только JPEG, PNG, WebP, GIF' });
  const body = await U.readBody(req, MAX_AVATAR_BYTES + 1);
  if (!body.length) return U.sendJSON(res, 400, { error: 'Пустой файл' });
  if (body.length > MAX_AVATAR_BYTES) {
    return U.sendJSON(res, 413, { error: `Файл слишком большой: ${(body.length / 1024 / 1024).toFixed(2)} МБ. Лимит: 5 МБ.` });
  }
  const ext = (path.extname(name).toLowerCase().match(/\.(jpe?g|png|webp|gif)$/) || ['.png'])[0].replace('jpeg', 'jpg');
  const storageName = `${auth.user.id}_${Date.now()}${ext}`;
  const full = path.join(AVATARS_DIR, storageName);
  fs.writeFileSync(full, body);
  const old = auth.user.avatar_file;
  if (old) { const p = path.join(AVATARS_DIR, old); if (fs.existsSync(p)) try { fs.unlinkSync(p); } catch {} }
  stmts.setAvatar.run(storageName, auth.user.id);
  const updated = stmts.getUserById.get(auth.user.id);
  broadcastPresence(auth.user.id);
  U.sendJSON(res, 200, { user: publicUser(updated, auth.user.id) });
}

async function handleDeleteAvatar(req, res, auth, nick) {
  if (auth.user.username.toLowerCase() !== U.normalizeUsername(nick)) return U.sendJSON(res, 403, { error: 'Forbidden' });
  const old = auth.user.avatar_file;
  if (old) { const p = path.join(AVATARS_DIR, old); if (fs.existsSync(p)) try { fs.unlinkSync(p); } catch {} }
  stmts.clearAvatar.run(auth.user.id);
  const updated = stmts.getUserById.get(auth.user.id);
  broadcastPresence(auth.user.id);
  U.sendJSON(res, 200, { user: publicUser(updated, auth.user.id) });
}

async function handlePostBanner(req, res, auth, nick) {
  if (auth.user.username.toLowerCase() !== U.normalizeUsername(nick)) return U.sendJSON(res, 403, { error: 'Forbidden' });
  const name = U.safeFilename(decodeURIComponent(String(req.headers['x-file-name'] || 'banner.png')));
  const type = String(req.headers['x-file-type'] || 'image/png');
  if (!U.isAllowedAvatar(type, name)) return U.sendJSON(res, 400, { error: 'Разрешены только JPEG, PNG, WebP, GIF' });
  const body = await U.readBody(req, MAX_BANNER_BYTES + 1);
  if (!body.length) return U.sendJSON(res, 400, { error: 'Пустой файл' });
  if (body.length > MAX_BANNER_BYTES) return U.sendJSON(res, 413, { error: `Файл слишком большой: ${(body.length / 1024 / 1024).toFixed(2)} МБ. Лимит: 8 МБ.` });
  const ext = (path.extname(name).toLowerCase().match(/\.(jpe?g|png|webp|gif)$/) || ['.png'])[0].replace('jpeg', 'jpg');
  const storageName = `${auth.user.id}_${Date.now()}${ext}`;
  fs.writeFileSync(path.join(BANNERS_DIR, storageName), body);
  const old = auth.user.banner_file;
  if (old) { const p = path.join(BANNERS_DIR, old); if (fs.existsSync(p)) try { fs.unlinkSync(p); } catch {} }
  stmts.setBanner.run(storageName, auth.user.id);
  U.sendJSON(res, 200, { user: publicUser(stmts.getUserById.get(auth.user.id), auth.user.id) });
}

async function handleDeleteBanner(req, res, auth, nick) {
  if (auth.user.username.toLowerCase() !== U.normalizeUsername(nick)) return U.sendJSON(res, 403, { error: 'Forbidden' });
  const old = auth.user.banner_file;
  if (old) { const p = path.join(BANNERS_DIR, old); if (fs.existsSync(p)) try { fs.unlinkSync(p); } catch {} }
  stmts.clearBanner.run(auth.user.id);
  U.sendJSON(res, 200, { user: publicUser(stmts.getUserById.get(auth.user.id), auth.user.id) });
}

// --- Blocks ---
function handleGetBlocks(req, res, auth) {
  U.sendJSON(res, 200, { blocks: stmts.listBlocks.all(auth.user.id) });
}
async function handleBlock(req, res, auth) {
  const body = await U.readJSON(req);
  const u = stmts.getUserByLower.get(U.normalizeUsername(body.username));
  if (!u) return U.sendJSON(res, 404, { error: 'Пользователь не найден' });
  if (u.id === auth.user.id) return U.sendJSON(res, 400, { error: 'Нельзя заблокировать себя' });
  stmts.blockUser.run(auth.user.id, u.id, U.now());
  U.sendJSON(res, 200, { ok: true });
}
async function handleUnblock(req, res, auth) {
  const body = await U.readJSON(req);
  const u = stmts.getUserByLower.get(U.normalizeUsername(body.username));
  if (!u) return U.sendJSON(res, 404, { error: 'Пользователь не найден' });
  stmts.unblockUser.run(auth.user.id, u.id);
  U.sendJSON(res, 200, { ok: true });
}
async function handleAdminPremium(req, res, auth) {
  if (!requireAdmin(auth, res)) return;
  const body = await U.readJSON(req);
  const u = stmts.getUserByLower.get(U.normalizeUsername(body.username));
  if (!u) return U.sendJSON(res, 404, { error: 'Пользователь не найден' });
  const premium = body.premium ? 1 : 0;
  const days = Math.max(1, Number(body.days) || 30);
  const until = premium ? (Number(body.until) || (Date.now() + days*24*3600*1000)) : 0;
  stmts.setPremium.run(premium, until, u.id);
  U.sendJSON(res, 200, { user: publicUser(stmts.getUserById.get(u.id), auth.user.id) });
}

function handleGiftsCatalog(req, res, auth) {
  const gifts = stmts.listGiftsCatalog.all();
  U.sendJSON(res, 200, { gifts });
}

function handleUserGifts(req, res, auth, userId) {
  const user = stmts.getUserById.get(userId);
  if (!user) return U.sendJSON(res, 404, { error: 'Пользователь не найден' });
  const gifts = stmts.listMyGifts.all(userId);
  U.sendJSON(res, 200, { gifts });
}

async function handleSendGift(req, res, auth) {
  const body = await U.readJSON(req);
  const to = stmts.getUserByLower.get(U.normalizeUsername(body.username));
  if (!to) return U.sendJSON(res, 404, { error: 'Пользователь не найден' });
  if (to.id === auth.user.id) return U.sendJSON(res, 400, { error: 'Нельзя отправить подарок себе' });
  const gift = stmts.getGift.get(String(body.giftId || ''));
  if (!gift) return U.sendJSON(res, 404, { error: 'Подарок не найден' });
  const msg = U.sanitizeText(body.message || '', 120);
  const id = U.uid('ug');
  stmts.sendGift.run(id, gift.id, auth.user.id, to.id, msg, U.now());
  wsSend(to.id, { type: 'gift_received', from: publicUser(auth.user, to.id), gift: { ...gift, message: msg } });
  U.sendJSON(res, 201, { ok: true, giftId: id });
}

const TAG_COLORS = ['#5b8cff','#22c55e','#f59e0b','#ef4444','#8b5cf6','#14b8a6','#ec4899','#f97316','#06b6d4','#eab308'];
function sanitizeTagColor(c){ return TAG_COLORS.includes(String(c||'').toLowerCase()) ? String(c).toLowerCase() : '#5b8cff'; }
function sanitizeTagIcon(i){ const icons=['','⭐','🔥','💎','🎮','🎵','🚀','💜','⚡','👑','🛡️','🌙','☀️']; return icons.includes(String(i||'')) ? String(i) : ''; }

async function handleBuyTag(req, res, auth) {
  const body = await U.readJSON(req);
  const tag = U.sanitizeText(body.tag || '', 24).replace(/[^a-zA-Z0-9_а-яА-ЯёЁ-]/g,'').slice(0,20);
  if (!tag) return U.sendJSON(res, 400, { error: 'Введите тег' });
  const color = sanitizeTagColor(body.color);
  const icon = sanitizeTagIcon(body.icon);
  // paid content: requires premium or admin
  if (!auth.user.is_premium && !auth.user.is_admin) return U.sendJSON(res, 403, { error: 'Кастомные теги доступны в Premium' });
  stmts.setTag.run(tag, auth.user.id);
  stmts.setTagStyle.run(color, icon, auth.user.id);
  const updated = stmts.getUserById.get(auth.user.id);
  U.sendJSON(res, 200, { user: publicUser(updated, auth.user.id) });
}
async function handleAdminGiveGift(req, res, auth) {
  if (!requireAdmin(auth, res)) return;
  const body = await U.readJSON(req);
  const to = stmts.getUserByLower.get(U.normalizeUsername(body.username));
  if (!to) return U.sendJSON(res, 404, { error: 'Пользователь не найден' });
  const gift = stmts.getGift.get(String(body.giftId || ''));
  if (!gift) return U.sendJSON(res, 404, { error: 'Подарок не найден' });
  const msg = U.sanitizeText(body.message || '', 120);
  const id = U.uid('ug');
  stmts.sendGift.run(id, gift.id, auth.user.id, to.id, msg, U.now());
  wsSend(to.id, { type: 'gift_received', from: publicUser(auth.user, to.id), gift: { ...gift, message: msg } });
  U.sendJSON(res, 201, { ok: true, giftId: id });
}

async function handleTransferGift(req, res, auth) {
  const body = await U.readJSON(req);
  const giftRow = stmts.getUserGift.get(String(body.userGiftId || ''));
  if (!giftRow) return U.sendJSON(res, 404, { error: 'Подарок не найден' });
  if (giftRow.to_user_id !== auth.user.id) return U.sendJSON(res, 403, { error: 'Можно передать только свой подарок' });
  const to = stmts.getUserByLower.get(U.normalizeUsername(body.username));
  if (!to) return U.sendJSON(res, 404, { error: 'Получатель не найден' });
  if (to.id === auth.user.id) return U.sendJSON(res, 400, { error: 'Нельзя передать подарок себе' });
  stmts.transferGift.run(to.id, U.now(), giftRow.id);
  const gift = stmts.getGift.get(giftRow.gift_id);
  wsSend(to.id, { type: 'gift_received', from: publicUser(auth.user, to.id), gift: { ...gift, message: giftRow.message || '' } });
  wsSend(auth.user.id, { type: 'gift_transferred', userGiftId: giftRow.id, to: publicUser(to, auth.user.id) });
  U.sendJSON(res, 200, { ok: true });
}

function handleMyGifts(req, res, auth) {
  U.sendJSON(res, 200, { gifts: stmts.listMyGifts.all(auth.user.id) });
}

// --- Router ---
async function router(req, res) {
  try {
    const urlObj = new URL(req.url, `http://${req.headers.host || `localhost:${PORT}`}`);
    const sec = checkRequestSecurity(req);
    if (!sec.ok) return U.sendJSON(res, sec.status, { error: sec.error });
    const pathname = decodeURIComponent(urlObj.pathname);

    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html' || pathname === '/chat.html')) {
      res.writeHead(302, { Location: '/pulse.html' }); return res.end();
    }
    if (req.method === 'GET' && serveStatic(req, res, pathname)) return;

    // Public auth
    if (pathname === '/api/register' && req.method === 'POST') return await handleRegister(req, res);
    if (pathname === '/api/login' && req.method === 'POST') return await handleLogin(req, res);
    if (pathname === '/api/logout' && req.method === 'POST') return handleLogout(req, res);

    // Avatar/banner GET can be public (URLs are used in <img>)
    const avatarGet = pathname.match(/^\/api\/avatar\/([^/]+)$/);
    if (avatarGet && req.method === 'GET') return handleGetAvatar(req, res, avatarGet[1]);
    const bannerGet = pathname.match(/^\/api\/banner\/([^/]+)$/);
    if (bannerGet && req.method === 'GET') return handleGetBanner(req, res, bannerGet[1]);

    const auth = getSessionUser(req);
    const need = () => { if (!auth) { U.sendJSON(res, 401, { error: 'Unauthorized' }); return null; } return auth; };

    
    const avatarPost = pathname.match(/^\/api\/avatar\/([^/]+)$/);
    if (avatarPost && req.method === 'POST') { if (!need()) return; return await handlePostAvatar(req, res, auth, avatarPost[1]); }
    if (avatarPost && req.method === 'DELETE') { if (!need()) return; return await handleDeleteAvatar(req, res, auth, avatarPost[1]); }
    const bannerPost = pathname.match(/^\/api\/banner\/([^/]+)$/);
    if (bannerPost && req.method === 'POST') { if (!need()) return; return await handlePostBanner(req, res, auth, bannerPost[1]); }
    if (bannerPost && req.method === 'DELETE') { if (!need()) return; return await handleDeleteBanner(req, res, auth, bannerPost[1]); }
if (pathname === '/api/me' && req.method === 'GET') { if (!need()) return; return handleMe(req, res, auth); }
    if (pathname === '/api/me' && req.method === 'PATCH') { if (!need()) return; return await handlePatchMe(req, res, auth); }
    if (pathname === '/api/users' && req.method === 'GET') { if (!need()) return; return handleUsers(req, res, auth); }

    if (pathname === '/api/chats' && req.method === 'GET') { if (!need()) return; return handleChats(req, res, auth); }
    if (pathname === '/api/chats' && req.method === 'POST') { if (!need()) return; return await handleCreateChat(req, res, auth); }
    if (pathname === '/api/chats/discover' && req.method === 'GET') { if (!need()) return; return handleDiscover(req, res, auth); }

    // route order: /api/chat/file/:id before /api/chat(s)/:id patterns
    if (pathname === '/api/chat/file' && req.method === 'POST') { if (!need()) return; return await handlePostChatFile(req, res, auth); }
    const fileMatch = pathname.match(/^\/api\/chat\/file\/([^/]+)$/);
    if (fileMatch && req.method === 'GET') { if (!need()) return; return handleGetChatFile(req, res, auth, fileMatch[1]); }

    const joinMatch = pathname.match(/^\/api\/chats\/([^/]+)\/join$/);
    if (joinMatch && req.method === 'POST') { if (!need()) return; return await handleJoinChat(req, res, auth, joinMatch[1]); }
    const leaveMatch = pathname.match(/^\/api\/chats\/([^/]+)\/leave$/);
    if (leaveMatch && req.method === 'POST') { if (!need()) return; return await handleLeaveChat(req, res, auth, leaveMatch[1]); }
    const addMemberMatch = pathname.match(/^\/api\/chats\/([^/]+)\/members$/);
    if (addMemberMatch && req.method === 'POST') { if (!need()) return; return await handleAddMember(req, res, auth, addMemberMatch[1]); }
    const removeMemberMatch = pathname.match(/^\/api\/chats\/([^/]+)\/members\/([^/]+)$/);
    if (removeMemberMatch && req.method === 'DELETE') { if (!need()) return; return await handleRemoveMember(req, res, auth, removeMemberMatch[1], removeMemberMatch[2]); }

    const chatMatch = pathname.match(/^\/api\/chats\/([^/]+)$/);
    if (chatMatch && req.method === 'GET') { if (!need()) return; return handleGetChat(req, res, auth, chatMatch[1]); }
    if (chatMatch && req.method === 'PATCH') { if (!need()) return; return await handleUpdateChat(req, res, auth, chatMatch[1]); }
    const chatMsgMatch = pathname.match(/^\/api\/chats\/([^/]+)\/messages$/);
    if (chatMsgMatch && req.method === 'POST') { if (!need()) return; return await handlePostMessage(req, res, auth, chatMsgMatch[1]); }
    const readMatch = pathname.match(/^\/api\/chats\/([^/]+)\/read$/);
    if (readMatch && req.method === 'POST') { if (!need()) return; return await handleRead(req, res, auth, readMatch[1]); }
    const pinMatch = pathname.match(/^\/api\/chats\/([^/]+)\/settings$/);
    if (pinMatch && req.method === 'POST') { if (!need()) return; return await handlePinMute(req, res, auth, pinMatch[1]); }

    const msgMatch = pathname.match(/^\/api\/messages\/([^/]+)$/);
    if (msgMatch && req.method === 'PATCH') { if (!need()) return; return await handleEditMessage(req, res, auth, msgMatch[1]); }
    if (msgMatch && req.method === 'DELETE') { if (!need()) return; return await handleDeleteMessage(req, res, auth, msgMatch[1], urlObj); }
    const reactMatch = pathname.match(/^\/api\/messages\/([^/]+)\/react$/);
    if (reactMatch && req.method === 'POST') { if (!need()) return; return await handleReact(req, res, auth, reactMatch[1]); }

    if (avatarGet && req.method === 'POST') { if (!need()) return; return await handlePostAvatar(req, res, auth, avatarGet[1]); }
    if (avatarGet && req.method === 'DELETE') { if (!need()) return; return await handleDeleteAvatar(req, res, auth, avatarGet[1]); }
    if (bannerGet && req.method === 'POST') { if (!need()) return; return await handlePostBanner(req, res, auth, bannerGet[1]); }

    if (pathname === '/api/blocks' && req.method === 'GET') { if (!need()) return; return handleGetBlocks(req, res, auth); }
    if (pathname === '/api/blocks' && req.method === 'POST') { if (!need()) return; return await handleBlock(req, res, auth); }
    if (pathname === '/api/blocks' && req.method === 'DELETE') { if (!need()) return; return await handleUnblock(req, res, auth); }

    // Gifts / Premium
    if (pathname === '/api/gifts/catalog' && req.method === 'GET') { if (!need()) return; return handleGiftsCatalog(req, res, auth); }
    if (pathname === '/api/gifts/send' && req.method === 'POST') { if (!need()) return; return await handleSendGift(req, res, auth); }
    if (pathname === '/api/gifts/transfer' && req.method === 'POST') { if (!need()) return; return await handleTransferGift(req, res, auth); }
    if (pathname === '/api/gifts/my' && req.method === 'GET') { if (!need()) return; return handleMyGifts(req, res, auth); }
    if (pathname === '/api/gifts/buy-tag' && req.method === 'POST') { if (!need()) return; return await handleBuyTag(req, res, auth); }
    const userGiftsMatch = pathname.match(/^\/api\/users\/([^/]+)\/gifts$/);
    if (userGiftsMatch && req.method === 'GET') { if (!need()) return; return handleUserGifts(req, res, auth, userGiftsMatch[1]); }

    // Admin
    if (pathname === '/api/admin/stats' && req.method === 'GET') { if (!need()) return; return handleAdminStats(req, res, auth); }
    if (pathname === '/api/admin/users' && req.method === 'GET') { if (!need()) return; return handleAdminUsers(req, res, auth); }
    if (pathname === '/api/admin/users/role' && req.method === 'POST') { if (!need()) return; return await handleAdminSetRole(req, res, auth); }
    if (pathname === '/api/admin/users/ban' && req.method === 'POST') { if (!need()) return; return await handleAdminBan(req, res, auth); }
    if (pathname === '/api/admin/users/premium' && req.method === 'POST') { if (!need()) return; return await handleAdminPremium(req, res, auth); }
    if (pathname === '/api/admin/users/tag' && req.method === 'POST') { if (!need()) return; return await handleAdminTag(req, res, auth); }
    if (pathname === '/api/admin/gifts/give' && req.method === 'POST') { if (!need()) return; return await handleAdminGiveGift(req, res, auth); }
    if (pathname === '/api/admin/chats' && req.method === 'GET') { if (!need()) return; return handleAdminChats(req, res, auth); }
    const adminChatDel = pathname.match(/^\/api\/admin\/chats\/([^/]+)$/);
    if (adminChatDel && req.method === 'DELETE') { if (!need()) return; return await handleAdminDeleteChat(req, res, auth, adminChatDel[1]); }

    return U.sendJSON(res, 404, { error: 'Not found' });
  } catch (err) {
    const status = err && err.status ? err.status : 500;
    if (status === 500) console.error(err);
    U.sendJSON(res, status, { error: status === 500 ? 'Internal server error' : err.message });
  }
}

// --- Seed ---
function seedGifts() {
  const gifts = [
    ['gift_star','⭐','Звезда',50,'linear-gradient(135deg,#f7b733,#fc4a1a)'],
    ['gift_heart','💖','Сердце',75,'linear-gradient(135deg,#ff4d6d,#c9184a)'],
    ['gift_fire','🔥','Огонь',100,'linear-gradient(135deg,#ff512f,#dd2476)'],
    ['gift_rocket','🚀','Ракета',150,'linear-gradient(135deg,#2193b0,#6dd5ed)'],
    ['gift_crown','👑','Корона',250,'linear-gradient(135deg,#f7971e,#ffd200)'],
    ['gift_diamond','💎','Алмаз',500,'linear-gradient(135deg,#00c6ff,#0072ff)'],
  ];
  for (const g of gifts) stmts.insertGiftCatalog.run(...g);
}

function ensureKompotAdmin() {
  const k = stmts.getUserByLower.get('kompotmik2');
  if (k) {
    if (!k.is_admin) stmts.setAdmin.run(1, k.id);
    if (!k.is_premium) stmts.setPremium.run(1, Date.now() + 365*24*3600*1000, k.id);
    if (!k.tag) stmts.setTag.run('founder', k.id);
  }
}

function seed() {
  stmts.cleanSessions.run(U.now());
  seedGifts();
  const count = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (count > 0) { ensureKompotAdmin(); return; }
  const t = U.now();
  const base = (u) => ({ bio:'', custom_status:'', custom_status_emoji:'', presence:'offline', last_seen:t, avatar_file:null, avatar_version:1, banner_file:null, banner_version:1, banner_gradient:'sunset', accent_color:'#5b8cff', bubble_style:'rounded', theme:'dark', chat_bg:'default', privacy_last_seen:'all', privacy_avatar:'all', privacy_online:'all', is_admin:0, is_banned:0, banned_reason:'', is_premium:0, premium_until:0, tag:'', created_at:t-86400000, ...u });
  const alice = base({ id: U.uid('u'), username: 'alice', display_name: 'Алиса', password_hash: U.hashPassword('password123'), bio: 'Дизайн и идеи', custom_status: 'В работе', custom_status_emoji: '🎨', is_premium:1, premium_until:t+30*24*3600*1000, tag:'designer' });
  const bob = base({ id: U.uid('u'), username: 'bob', display_name: 'Боб', password_hash: U.hashPassword('password123'), bio: 'Пишу код', custom_status: 'На связи', custom_status_emoji: '💻', accent_color:'#22c55e', banner_gradient:'ocean' });
  const admin = base({ id: U.uid('u'), username: 'kompotmik2', display_name: 'Kompot Admin', password_hash: U.hashPassword('kompotmik2_admin'), bio: 'Администратор PulseChat', custom_status: 'Управляю платформой', custom_status_emoji: '🛡️', is_admin: 1, is_premium:1, premium_until:t+365*24*3600*1000, tag:'founder', accent_color:'#ef4444', banner_gradient:'rose' });
  stmts.createUser.run(alice); stmts.createUser.run(bob); stmts.createUser.run(admin);
  const chat = ensureDM(alice.id, bob.id);
  stmts.createMessage.run({ id: U.uid('m'), chat_id: chat.id, sender_id: alice.id, text: 'Привет! Это PulseChat — пробуем новый мессенджер.', reply_to_id: null, forwarded_from: null, edited_at: null, deleted_for_all: 0, created_at: t - 60000 });
  stmts.createMessage.run({ id: U.uid('m'), chat_id: chat.id, sender_id: bob.id, text: 'Привет! Выглядит отлично. Проверю профиль и загрузку аватара.', reply_to_id: null, forwarded_from: null, edited_at: null, deleted_for_all: 0, created_at: t - 30000 });
  stmts.updateChatUpdated.run(t-30000, chat.id);
  const chId = U.uid('c');
  stmts.createChat.run(chId, 'channel', 'PulseChat Новости', 'Официальные обновления платформы', 'pulse_news', null, 1, admin.id, 1, t-20000, t-20000);
  stmts.addMember.run(chId, admin.id, 'owner', 0, 0, null, 0, t-20000);
  stmts.addMember.run(chId, alice.id, 'member', 0, 0, null, 0, t-20000);
  stmts.addMember.run(chId, bob.id, 'member', 0, 0, null, 0, t-20000);
  stmts.createMessage.run({ id: U.uid('m'), chat_id: chId, sender_id: admin.id, text: 'Добро пожаловать в канал PulseChat! Здесь будут новости и обновления.', reply_to_id: null, forwarded_from: null, edited_at: null, deleted_for_all: 0, created_at: t-15000 });
  stmts.updateChatUpdated.run(t-15000, chId);
  console.log('Seeded demo users: alice/password123, bob/password123, kompotmik2/kompotmik2_admin');
}

seed();
const server = http.createServer(router);
setupWS(server);
server.listen(PORT, () => console.log(`PulseChat running at http://localhost:${PORT}/pulse.html`));