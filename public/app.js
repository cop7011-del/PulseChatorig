(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const toastRoot = $('#toastRoot');
  const state = {
    me: null, users: [], chats: [], activeChatId: null,
    messages: new Map(), typing: new Map(), replyTo: null, editing: null,
    ws: null, wsTimer: null, search: '',
  };

  function toast(msg, type = '') {
    const el = document.createElement('div');
    el.className = `toast ${type}`.trim();
    el.textContent = msg;
    toastRoot.appendChild(el);
    setTimeout(() => el.remove(), 3200);
  }
  function escapeHTML(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function fmtTime(ts) { return new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }); }
  function fmtDay(ts) {
    const d = new Date(ts), now = new Date(); const y = new Date(now); y.setDate(now.getDate() - 1);
    if (d.toDateString() === now.toDateString()) return 'Сегодня';
    if (d.toDateString() === y.toDateString()) return 'Вчера';
    return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
  }
  function fmtChatTime(ts) {
    if (!ts) return '';
    const d = new Date(ts), now = new Date(); const y = new Date(now); y.setDate(now.getDate() - 1);
    if (d.toDateString() === now.toDateString()) return fmtTime(ts);
    if (d.toDateString() === y.toDateString()) return 'вчера';
    return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
  }
  function fmtBytes(bytes) {
    if (bytes < 1024) return bytes + ' B';
    const kb = bytes / 1024; if (kb < 1024) return kb.toFixed(kb < 10 ? 1 : 0) + ' KB';
    return (kb / 1024).toFixed((kb / 1024) < 10 ? 1 : 0) + ' MB';
  }
  function initials(name) {
    const p = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!p.length) return '?';
    return ((p[0][0] || '') + (p[1] ? p[1][0] : (p[0][1] || ''))).toUpperCase();
  }
  function colorFor(str) {
    const colors = ['#5b8cff', '#22c55e', '#f59e0b', '#ef4444', '#8b5cf6', '#14b8a6', '#ec4899'];
    let h = 0; const s = String(str || ''); for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return colors[h % colors.length];
  }
  function setAvatar(el, user) {
    if (!el) return;
    el.innerHTML = '';
    const name = user.displayName || user.title || '?';
    el.style.background = user.avatarUrl ? 'transparent' : `linear-gradient(135deg, ${colorFor(user.username || user.id)}, ${colorFor(name + (user.id || ''))})`;
    if (user.avatarUrl) {
      const img = document.createElement('img');
      img.className = 'avatar-img'; img.alt = name; img.src = user.avatarUrl;
      img.onerror = () => { el.innerHTML = ''; el.textContent = initials(name); el.style.background = `linear-gradient(135deg, ${colorFor(user.username)}, ${colorFor(name)})`; };
      el.appendChild(img);
    } else el.textContent = initials(name);
  }
  async function api(path, opts = {}) {
    const res = await fetch(path, { credentials: 'same-origin', headers: { 'Accept': 'application/json', ...(opts.headers || {}) }, ...opts });
    const ct = res.headers.get('content-type') || '';
    const data = ct.includes('application/json') ? await res.json().catch(() => null) : await res.text().catch(() => '');
    if (!res.ok) { const err = new Error((data && data.error) || res.statusText || 'Ошибка запроса'); err.status = res.status; err.data = data; throw err; }
    return data;
  }

  function applyPrefs() {
    if (!state.me) return;
    const root = document.documentElement;
    const theme = state.me.theme || 'dark';
    const resolved = theme === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : theme;
    root.dataset.theme = resolved;
    root.style.setProperty('--accent', state.me.accentColor || '#5b8cff');
    document.body.classList.remove('style-rounded', 'style-sharp', 'style-minimal');
    document.body.classList.add(`style-${state.me.bubbleStyle || 'rounded'}`);
  }

  function connectWS() {
    if (state.ws) { try { state.ws.close(); } catch {} }
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    state.ws = ws;
    ws.onmessage = (e) => { try { handleWS(JSON.parse(e.data)); } catch {} };
    ws.onclose = () => { if (state.me) state.wsTimer = setTimeout(connectWS, 2000); };
    ws.onerror = () => { try { ws.close(); } catch {} };
  }
  function wsSend(obj) { if (state.ws && state.ws.readyState === 1) state.ws.send(JSON.stringify(obj)); }

  function handleWS(msg) {
    if (msg.type === 'message') {
      const arr = state.messages.get(msg.chatId) || [];
      if (!arr.find(m => m.id === msg.message.id)) arr.push(msg.message);
      state.messages.set(msg.chatId, arr);
      const c = state.chats.find(x => x.id === msg.chatId);
      if (c) { c.lastMessage = msg.message; c.updatedAt = msg.message.createdAt; if (state.activeChatId !== msg.chatId && msg.message.senderId !== state.me.id) c.unread = (c.unread || 0) + 1; }
      if (state.activeChatId === msg.chatId) { renderMessages(); markReadIfNeeded(); }
      renderChatList();
      if (msg.message.senderId !== state.me.id) maybeNotify(msg);
    }
    if (msg.type === 'message_updated') {
      const arr = state.messages.get(msg.chatId) || [];
      const i = arr.findIndex(m => m.id === msg.message.id);
      if (i !== -1) arr[i] = msg.message; else arr.push(msg.message);
      state.messages.set(msg.chatId, arr);
      if (state.activeChatId === msg.chatId) renderMessages();
      renderChatList();
    }
    if (msg.type === 'message_deleted_for_me') {
      state.messages.set(msg.chatId, (state.messages.get(msg.chatId) || []).filter(m => m.id !== msg.messageId));
      if (state.activeChatId === msg.chatId) renderMessages();
      renderChatList();
    }
    if (msg.type === 'typing') {
      if (!state.typing.has(msg.chatId)) state.typing.set(msg.chatId, new Map());
      const m = state.typing.get(msg.chatId);
      if (msg.typing) m.set(msg.userId, { name: msg.displayName || 'Пользователь', until: Date.now() + 3500 });
      else m.delete(msg.userId);
      if (state.activeChatId === msg.chatId) renderHeader();
      renderChatList();
    }
    if (msg.type === 'presence') {
      state.users = state.users.map(u => u.id === msg.user.id ? { ...u, ...msg.user } : u);
      if (state.me && msg.user.id === state.me.id) state.me = { ...state.me, ...msg.user };
      state.chats = state.chats.map(c => {
        if (c.peer && c.peer.id === msg.user.id) { c.peer = { ...c.peer, ...msg.user }; c.title = c.peer.displayName; c.avatarUrl = c.peer.avatarUrl; }
        c.members = (c.members || []).map(m => m.id === msg.user.id ? { ...m, ...msg.user } : m);
        return c;
      });
      renderChatList(); renderHeader();
    }
    if (msg.type === 'chat_created' || msg.type === 'chat_updated') { upsertChat(msg.chat); renderChatList(); if (state.activeChatId === msg.chat.id) renderHeader(); }
    if (msg.type === 'chat_left') { state.chats = state.chats.filter(c => c.id !== msg.chatId); state.messages.delete(msg.chatId); if (state.activeChatId === msg.chatId) { state.activeChatId = null; $('#emptyState').classList.remove('hidden'); $('#messages').classList.add('hidden'); $('#composer').classList.add('hidden'); $('#chatHeader').classList.add('hidden'); } renderChatList(); }
    if (msg.type === 'gift_received') { toast(`Вам подарок: ${msg.gift?.emoji||'🎁'} ${msg.gift?.name||''}`, 'ok'); if($('#ucGifts')) loadUserGifts(state.me.id,'#ucGifts',true); }
    if (msg.type === 'gift_transferred') { toast('Подарок передан', 'ok'); if($('#ucGifts')) loadUserGifts(state.me.id,'#ucGifts',true); }
    if (['call_offer','call_answer','call_ice','call_end','call_reject','call_busy'].includes(msg.type)) { handleCallSignal(msg); }
    if (msg.type === 'read') { loadChats().catch(() => {}); }
  }

  function upsertChat(chat) { const i = state.chats.findIndex(c => c.id === chat.id); if (i === -1) state.chats.unshift(chat); else state.chats[i] = chat; }
  function maybeNotify(msg) {
    const chat = state.chats.find(c => c.id === msg.chatId);
    if (chat && chat.muted) return;
    if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
      try { new Notification(chat ? chat.title : 'PulseChat', { body: msg.message.text || (msg.message.attachments?.[0]?.name || 'Новое сообщение') }); } catch {}
    }
  }

  async function loadMe() { const d = await api('/api/me'); state.me = d.user; applyPrefs(); }
  async function loadUsers() { const d = await api('/api/users'); state.users = d.users || []; }
  async function loadChats() { const d = await api('/api/chats'); state.chats = d.chats || []; renderChatList(); }
  async function loadChat(chatId) { const d = await api(`/api/chats/${encodeURIComponent(chatId)}`); upsertChat(d.chat); state.messages.set(chatId, d.messages || []); return d; }

  function showAuth() { $('#authView').classList.remove('hidden'); $('#appView').classList.add('hidden'); }
  function showApp() { $('#authView').classList.add('hidden'); $('#appView').classList.remove('hidden'); renderMe(); renderChatList(); }
  function renderMe() {
    if (!state.me) return;
    setAvatar($('#myAvatar'), state.me);
    $('#myName').textContent = state.me.displayName;
    const p = state.me.presence === 'online' ? 'в сети' : state.me.presence === 'dnd' ? 'не беспокоить' : state.me.presence === 'away' ? 'отошёл' : state.me.presence === 'invisible' ? 'невидимка' : 'офлайн';
    const badges = [state.me.isPremium?'⭐ Premium':'', state.me.tag?('#'+state.me.tag):''].filter(Boolean).join(' • ');
    $('#myStatus').textContent = (state.me.customStatus ? `${state.me.customStatusEmoji || ''} ${state.me.customStatus}`.trim() : p) + (badges ? ' • ' + badges : '');
    const isAdmin = !!state.me.isAdmin || String(state.me.username||'').toLowerCase()==='kompotmik2';
    state.me.isAdmin = isAdmin;
    $('#adminBtn').classList.toggle('hidden', !isAdmin);
  }

  function filteredChats() {
    const q = state.search.trim().toLowerCase();
    let list = [...state.chats];
    if (q) list = list.filter(c => {
      const hay = [c.title, c.peer?.username, ...(c.members || []).map(m => m.username), ...(c.members || []).map(m => m.displayName)].join(' ').toLowerCase();
      if (hay.includes(q)) return true;
      return (state.messages.get(c.id) || []).some(m => (m.text || '').toLowerCase().includes(q));
    });
    list.sort((a, b) => (b.pinned - a.pinned) || ((b.updatedAt || 0) - (a.updatedAt || 0)));
    return list;
  }

  function renderChatList() {
    const root = $('#chatList'); root.innerHTML = '';
    const list = filteredChats();
    if (!list.length) { root.innerHTML = `<div class="empty-list">${state.search ? 'Ничего не найдено' : 'Нет чатов. Создайте новый.'}</div>`; return; }
    const tpl = $('#chatItemTpl');
    for (const c of list) {
      const node = tpl.content.firstElementChild.cloneNode(true);
      node.dataset.id = c.id;
      if (c.id === state.activeChatId) node.classList.add('active');
      const avUser = c.type === 'dm' && c.peer ? c.peer : { displayName: c.title, username: c.id, avatarUrl: c.avatarUrl, id: c.id };
      setAvatar(node.querySelector('.chat-avatar'), avUser);
      node.querySelector('.chat-item-name').textContent = c.title || 'Чат';
      const last = c.lastMessage;
      let preview = 'Нет сообщений';
      if (last) {
        const prefix = last.senderId === state.me.id ? 'Вы: ' : '';
        if (last.deletedForAll) preview = prefix + 'Сообщение удалено';
        else if (last.attachments?.length && last.text) preview = prefix + '📎 ' + last.text;
        else if (last.attachments?.length) preview = prefix + '📎 ' + last.attachments[0].name;
        else preview = prefix + (last.text || '');
      }
      const tmap = state.typing.get(c.id);
      if (tmap && tmap.size) preview = 'печатает...';
      node.querySelector('.chat-item-preview').textContent = preview;
      node.querySelector('.chat-item-time').textContent = last ? fmtChatTime(last.createdAt) : '';
      const meta = node.querySelector('.chat-item-meta'); meta.innerHTML = '';
      if (c.pinned) meta.insertAdjacentHTML('beforeend', '<span class="pin">📌</span>');
      if (c.muted) meta.insertAdjacentHTML('beforeend', '<span class="pin">🔕</span>');
      if (c.unread) meta.insertAdjacentHTML('beforeend', `<span class="badge">${c.unread}</span>`);
      node.addEventListener('click', () => openChat(c.id));
      root.appendChild(node);
    }
  }

  function renderHeader() {
    const chat = state.chats.find(c => c.id === state.activeChatId);
    if (!chat) { $('#chatHeader').classList.add('hidden'); return; }
    $('#chatHeader').classList.remove('hidden');
    const avUser = chat.type === 'dm' && chat.peer ? chat.peer : { displayName: chat.title, username: chat.id, avatarUrl: chat.avatarUrl, id: chat.id };
    setAvatar($('#chatAvatar'), avUser);
    $('#chatTitle').textContent = chat.title;
    const tmap = state.typing.get(chat.id);
    if (tmap && tmap.size) $('#chatSub').textContent = [...tmap.values()].map(v => v.name).join(', ') + ' печатает...';
    else if (chat.type === 'dm' && chat.peer) {
      const p = chat.peer;
      let st = p.presence === 'online' ? 'в сети' : p.presence === 'dnd' ? 'не беспокоить' : p.presence === 'away' ? 'отошёл' : (p.lastSeen ? `был(а) ${fmtChatTime(p.lastSeen)}` : 'офлайн');
      if (p.customStatus) st = `${p.customStatusEmoji || ''} ${p.customStatus} • ${st}`.trim();
      $('#chatSub').textContent = '@' + p.username + ' • ' + st;
    } else {
      const kind = chat.type === 'channel' ? 'канал' : 'группа';
      const pub = chat.isPublic ? 'публичный' : 'приватный';
      $('#chatSub').textContent = `${kind}, ${pub} • ${(chat.members || []).length} участников`;
    }
  }  function renderMessages() {
    const root = $('#messages');
    const chat = state.chats.find(c => c.id === state.activeChatId);
    const msgs = state.messages.get(state.activeChatId) || [];
    root.innerHTML = '';
    if (!chat) return;
    let lastDay = '';
    for (const m of msgs) {
      if (m.deletedForMe) continue;
      const day = fmtDay(m.createdAt);
      if (day !== lastDay) { const sep = document.createElement('div'); sep.className = 'day-sep'; sep.textContent = day; root.appendChild(sep); lastDay = day; }
      root.appendChild(renderMessage(m, chat));
    }
    if (!root.children.length) root.innerHTML = '<div class="day-sep">Начните диалог</div>';
    root.scrollTop = root.scrollHeight;
  }

  function renderMessage(m, chat) {
    const mine = m.senderId === state.me.id;
    const row = document.createElement('div');
    row.className = `msg-row ${mine ? 'sent' : 'received'}`;
    row.dataset.mid = m.id;
    if (chat.type === 'group' && !mine) { const av = document.createElement('div'); av.className = 'avatar msg-avatar'; setAvatar(av, m.sender || { displayName: '?' }); row.appendChild(av); }
    const bubble = document.createElement('div');
    bubble.className = 'bubble' + (m.deletedForAll ? ' deleted' : '');
    if (chat.type === 'group' && !mine) { const sn = document.createElement('div'); sn.className = 'msg-sender'; sn.textContent = m.sender?.displayName || ''; bubble.appendChild(sn); }
    if (m.replyTo) {
      const rq = document.createElement('div'); rq.className = 'reply-quote';
      rq.innerHTML = `<div class="rq-name">${escapeHTML(m.replyTo.senderName || '')}</div><div>${escapeHTML(m.replyTo.deletedForAll ? 'Сообщение удалено' : (m.replyTo.text || 'Вложение'))}</div>`;
      rq.onclick = () => { const el = $(`.msg-row[data-mid="${CSS.escape(m.replyTo.id)}"]`); if (el) el.scrollIntoView({behavior:'smooth', block:'center'}); };
      bubble.appendChild(rq);
    }
    if (!m.deletedForAll && m.attachments?.length) {
      const atts = document.createElement('div'); atts.className = 'attachments';
      for (const a of m.attachments) atts.appendChild(renderAttachment(a));
      bubble.appendChild(atts);
    }
    if (m.deletedForAll) { const p = document.createElement('p'); p.className = 'bubble-text'; p.textContent = 'Сообщение удалено'; bubble.appendChild(p); }
    else if (m.text) { const p = document.createElement('p'); p.className = 'bubble-text'; p.textContent = m.text; bubble.appendChild(p); }
    const meta = document.createElement('div'); meta.className = 'bubble-meta';
    if (m.editedAt) { const e = document.createElement('span'); e.className = 'edited'; e.textContent = 'изменено'; meta.appendChild(e); }
    const tm = document.createElement('span'); tm.textContent = fmtTime(m.createdAt); meta.appendChild(tm);
    if (mine) { const st = document.createElement('span'); st.textContent = '✓✓'; meta.appendChild(st); }
    bubble.appendChild(meta);
    if (!m.deletedForAll) {
      const acts = document.createElement('div'); acts.className = 'msg-actions';
      acts.appendChild(iconAction('↩', 'Ответить', () => setReply(m)));
      acts.appendChild(iconAction('😊', 'Реакция', (ev) => openReactionPicker(ev, m)));
      if (mine) acts.appendChild(iconAction('✎', 'Редактировать', () => startEdit(m)));
      acts.appendChild(iconAction('⋯', 'Ещё', (ev) => openMsgMenu(ev, m)));
      bubble.appendChild(acts);
    }
    const reactions = m.reactions || {};
    const rkeys = Object.keys(reactions);
    if (rkeys.length) {
      const rwrap = document.createElement('div'); rwrap.className = 'reactions';
      for (const emoji of rkeys) {
        const users = reactions[emoji];
        const b = document.createElement('button'); b.className = 'reaction' + (users.includes(state.me.id) ? ' mine' : '');
        b.textContent = `${emoji} ${users.length}`;
        b.onclick = () => toggleReaction(m, emoji);
        rwrap.appendChild(b);
      }
      bubble.appendChild(rwrap);
    }
    row.appendChild(bubble);
    return row;
  }

  function iconAction(label, title, fn) { const b = document.createElement('button'); b.type='button'; b.className='icon-btn'; b.title=title; b.textContent=label; b.onclick=(e)=>{e.stopPropagation(); fn(e);}; return b; }
  function renderAttachment(a) {
    if (a.kind === 'voice' || /\.(webm|ogg|mp3|wav|m4a)$/i.test(a.name || '')) {
      const wrap = document.createElement('div'); wrap.className = 'voice';
      const audio = document.createElement('audio'); audio.controls = true; audio.src = a.url; wrap.appendChild(audio); return wrap;
    }
    if (a.inline) {
      const link = document.createElement('a'); link.className = 'attach-img'; link.href = a.url; link.target = '_blank'; link.rel = 'noopener';
      const img = document.createElement('img'); img.src = a.url; img.alt = a.name; img.loading = 'lazy'; link.appendChild(img); return link;
    }
    const link = document.createElement('a'); link.className = 'attach-file'; link.href = a.url; link.target = '_blank'; link.rel = 'noopener'; link.download = a.name || '';
    link.innerHTML = `<span style="font-size:1.4rem">📄</span><span class="af-meta"><span class="af-name">${escapeHTML(a.name || 'файл')}</span><span class="af-size">${fmtBytes(a.size || 0)}</span></span>`;
    return link;
  }

  async function openChat(chatId) {
    state.activeChatId = chatId; state.replyTo = null; state.editing = null; renderReplyBar();
    $('#appView').classList.add('mobile-chat');
    $('#emptyState').classList.add('hidden'); $('#messages').classList.remove('hidden');
    try {
      await loadChat(chatId);
      renderHeader(); renderMessages(); renderChatList();
      const chat = state.chats.find(x => x.id === chatId);
      $('#composer').classList.toggle('hidden', !!(chat && chat.canPost === false));
      await api(`/api/chats/${encodeURIComponent(chatId)}/read`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
      if (chat) chat.unread = 0; renderChatList();
    } catch (e) { toast(e.message, 'err'); }
  }
  async function markReadIfNeeded() { if (!state.activeChatId) return; const c = state.chats.find(x => x.id === state.activeChatId); if (c) c.unread = 0; try { await api(`/api/chats/${encodeURIComponent(state.activeChatId)}/read`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({}) }); } catch {} }

  function setReply(m) { state.replyTo = m; state.editing = null; renderReplyBar(); $('#messageInput').focus(); }
  function startEdit(m) { state.editing = m; state.replyTo = null; $('#messageInput').value = m.text || ''; renderReplyBar(); $('#messageInput').focus(); }
  function renderReplyBar() {
    const bar = $('#replyBar');
    if (state.replyTo) { bar.classList.remove('hidden'); $('.reply-bar-title').textContent = 'Ответ на сообщение'; $('#replyBarText').textContent = state.replyTo.text || (state.replyTo.attachments?.[0]?.name || 'Вложение'); }
    else if (state.editing) { bar.classList.remove('hidden'); $('.reply-bar-title').textContent = 'Редактирование'; $('#replyBarText').textContent = state.editing.text || ''; }
    else bar.classList.add('hidden');
  }

  async function sendMessage() {
    const input = $('#messageInput');
    const text = input.value.trim();
    if (!text || !state.activeChatId) return;
    const btn = $('#sendBtn'); btn.disabled = true;
    try {
      if (state.editing) {
        await api(`/api/messages/${encodeURIComponent(state.editing.id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
        state.editing = null;
      } else {
        await api(`/api/chats/${encodeURIComponent(state.activeChatId)}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, replyToId: state.replyTo?.id || null }) });
        state.replyTo = null;
      }
      input.value = ''; autoGrow(input); renderReplyBar();
    } catch (e) { toast(e.message, 'err'); }
    finally { btn.disabled = false; input.focus(); }
  }

  function uploadFile(file, kind) {
    return new Promise((resolve, reject) => {
      if (!file || !state.activeChatId) return reject(new Error('Нет файла'));
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/chat/file');
      xhr.withCredentials = true;
      xhr.setRequestHeader('X-Chat-Id', state.activeChatId);
      xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name || 'file'));
      xhr.setRequestHeader('X-File-Type', file.type || 'application/octet-stream');
      xhr.setRequestHeader('X-Chat-Text', encodeURIComponent($('#messageInput').value.trim() || ''));
      xhr.setRequestHeader('X-Reply-To', state.replyTo?.id || '');
      xhr.setRequestHeader('X-File-Kind', kind || (file.type.startsWith('image/') ? 'image' : 'file'));
      xhr.upload.onprogress = (e) => { if (e.lengthComputable) { $('#uploadStatus').textContent = `Загрузка: ${Math.round(e.loaded / e.total * 100)}%`; $('#uploadStatus').classList.remove('hidden'); } };
      xhr.onload = () => { $('#uploadStatus').classList.add('hidden'); if (xhr.status >= 200 && xhr.status < 300) { try { resolve(JSON.parse(xhr.responseText)); } catch { resolve({}); } } else { let msg='Ошибка загрузки'; try { msg = JSON.parse(xhr.responseText).error || msg; } catch {} reject(new Error(msg)); } };
      xhr.onerror = () => { $('#uploadStatus').classList.add('hidden'); reject(new Error('Ошибка сети')); };
      xhr.send(file);
    });
  }
  async function handleFile(file, kind) {
    if (!file) return;
    try { await uploadFile(file, kind); $('#messageInput').value = ''; autoGrow($('#messageInput')); state.replyTo = null; renderReplyBar(); }
    catch (e) { toast(e.message, 'err'); }
  }

  async function toggleReaction(m, emoji) { try { await api(`/api/messages/${encodeURIComponent(m.id)}/react`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ emoji }) }); } catch(e){ toast(e.message,'err'); } }
  function openReactionPicker(ev, m) { closeCtx(); const menu=document.createElement('div'); menu.className='ctx-menu'; ['👍','❤️','😂','🔥','😮','😢'].forEach(emoji=>{ const b=document.createElement('button'); b.className='ctx-item'; b.textContent=emoji; b.onclick=()=>{ toggleReaction(m,emoji); closeCtx(); }; menu.appendChild(b); }); positionMenu(menu, ev.clientX, ev.clientY); }
  function openMsgMenu(ev, m) {
    closeCtx(); const menu = document.createElement('div'); menu.className='ctx-menu';
    addCtx(menu,'Ответить',()=>setReply(m)); addCtx(menu,'Переслать',()=>forwardMessage(m));
    if (m.senderId===state.me.id) addCtx(menu,'Редактировать',()=>startEdit(m));
    addCtx(menu,'Удалить у меня',()=>deleteMessage(m,false));
    if (m.senderId===state.me.id) addCtx(menu,'Удалить у всех',()=>deleteMessage(m,true),true);
    positionMenu(menu, ev.clientX, ev.clientY);
  }
  function addCtx(menu,label,fn,danger){ const b=document.createElement('button'); b.className='ctx-item'+(danger?' danger':''); b.textContent=label; b.onclick=()=>{ closeCtx(); fn(); }; menu.appendChild(b); }
  function positionMenu(menu,x,y){ document.body.appendChild(menu); const r=menu.getBoundingClientRect(); menu.style.left=Math.max(8,Math.min(x,innerWidth-r.width-8))+'px'; menu.style.top=Math.max(8,Math.min(y,innerHeight-r.height-8))+'px'; setTimeout(()=>document.addEventListener('click', closeCtx,{once:true}),0); }
  function closeCtx(){ $$('.ctx-menu').forEach(n=>n.remove()); }
  async function deleteMessage(m, forAll){ if(!confirm(forAll?'Удалить сообщение у всех?':'Удалить сообщение у себя?')) return; try { await api(`/api/messages/${encodeURIComponent(m.id)}?forAll=${forAll?'1':'0'}`, {method:'DELETE'}); } catch(e){ toast(e.message,'err'); } }
  async function forwardMessage(m){
    const targets = state.chats.filter(c=>c.id!==state.activeChatId); if(!targets.length) return toast('Нет чатов для пересылки');
    const name = prompt('Введите название чата или username получателя для пересылки:'); if(!name) return;
    const q=name.trim().toLowerCase(); const chat=targets.find(c=>c.title.toLowerCase().includes(q) || c.peer?.username.toLowerCase()===q);
    if(!chat) return toast('Чат не найден','err');
    try { await api(`/api/chats/${encodeURIComponent(chat.id)}/messages`, {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ text: m.text || '(вложение)', forwardedFrom: m.sender?.displayName || 'Пользователь' })}); toast('Сообщение переслано','ok'); }
    catch(e){ toast(e.message,'err'); }
  }
  // Settings / profile
  function openSettings() {
    const me = state.me;
    openModal(`
      <div class="modal-h"><h3>Настройки профиля</h3><button class="icon-btn" data-close>✕</button></div>
      <div class="modal-b">
        <div class="profile-hero">
          <div id="setBanner" class="profile-banner"></div>
          <div class="profile-hero-body">
            <div id="setAvatar" class="avatar"></div>
            <div class="profile-hero-meta"><h4 id="setHeroName"></h4><p id="setHeroUser"></p></div>
          </div>
        </div>

        <div class="section-title">Аватар (лимит 5 МБ)</div>
        <div class="avatar-editor">
          <div class="avatar-crop" id="avatarCrop"><img id="avatarCropImg" alt="preview"></div>
          <div class="avatar-editor-controls stack">
            <div class="row">
              <input id="avatarFile" type="file" accept="image/jpeg,image/png,image/webp,image/gif" hidden>
              <button class="btn" id="avatarPick">Выбрать файл</button>
              <button class="btn ghost" id="avatarReset">Сбросить аватар</button>
            </div>
            <label class="field"><span>Масштаб</span><input id="avatarZoom" class="range" type="range" min="1" max="3" step="0.01" value="1"></label>
            <label class="field"><span>Позиция X</span><input id="avatarX" class="range" type="range" min="-100" max="100" step="1" value="0"></label>
            <label class="field"><span>Позиция Y</span><input id="avatarY" class="range" type="range" min="-100" max="100" step="1" value="0"></label>
            <div class="hint" id="avatarHint">JPEG/PNG/WebP/GIF, до 5 МБ. Предпросмотр перед сохранением.</div>
            <div class="row"><button class="btn primary" id="avatarSave">Сохранить аватар</button></div>
          </div>
        </div>

        <div class="section-title">Баннер / обложка</div>
        <div class="row" style="margin-bottom:10px">
          <input id="bannerFile" type="file" accept="image/jpeg,image/png,image/webp,image/gif" hidden>
          <button class="btn" id="bannerPick">Загрузить баннер</button>
        </div>
        <div class="chips" id="bannerGradients"></div>

        <div class="section-title">Профиль</div>
        <div class="grid-2">
          <label class="field"><span>Отображаемое имя</span><input id="setDisplayName" maxlength="40"></label>
          <label class="field"><span>Username</span><input id="setUsername" maxlength="24" pattern="[a-zA-Z0-9_]+"></label>
        </div>
        <label class="field"><span>О себе</span><textarea id="setBio" rows="3" maxlength="200"></textarea><div class="hint"><span id="bioCount">0</span>/200</div></label>
        <div class="grid-2">
          <label class="field"><span>Статус</span><input id="setStatus" maxlength="60" placeholder="Чем заняты?"></label>
          <label class="field"><span>Эмодзи статуса</span><input id="setStatusEmoji" maxlength="8" placeholder="💬"></label>
        </div>
        <label class="field"><span>Присутствие</span>
          <select id="setPresence"><option value="online">В сети</option><option value="dnd">Не беспокоить</option><option value="away">Отошёл</option><option value="invisible">Невидимка</option></select>
        </label>

        <div class="section-title">Внешний вид</div>
        <div class="field"><span>Акцентный цвет</span><div class="color-row" id="accentRow"></div></div>
        <div class="field"><span>Стиль пузырьков</span><div class="chips" id="bubbleStyles"></div></div>
        <div class="field"><span>Тема</span><div class="chips" id="themeChips"></div></div>
        <div class="preview-bubbles style-${me.bubbleStyle}" id="stylePreview">
          <div class="msg-row received"><div class="bubble">Привет! Как тебе новый стиль?</div></div>
          <div class="msg-row sent"><div class="bubble">Очень аккуратно выглядит ✨</div></div>
        </div>

        <div class="section-title">Приватность</div>
        <div class="grid-2">
          <label class="field"><span>Кто видит «в сети»</span><select id="privOnline"><option value="all">Все</option><option value="contacts">Контакты</option><option value="nobody">Никто</option></select></label>
          <label class="field"><span>Кто видит аватар</span><select id="privAvatar"><option value="all">Все</option><option value="contacts">Контакты</option><option value="nobody">Никто</option></select></label>
        </div>
        <label class="field"><span>Кто видит последний визит</span><select id="privLast"><option value="all">Все</option><option value="contacts">Контакты</option><option value="nobody">Никто</option></select></label>

        <div class="section-title">Кастомный тег (Premium)</div>
        <div class="tag-customizer">
          <div class="row">
            <label class="field" style="flex:1"><span>Текст тега</span><input id="tagText" maxlength="20" placeholder="например, gamer"></label>
            <label class="field" style="width:160px"><span>Цвет</span><input id="tagColor" type="color" value="${escapeHTML(me.tagColor||'#5b8cff')}" style="height:44px;padding:4px"></label>
          </div>
          <div class="field-label">Иконка</div>
          <div id="tagIcons" class="row" style="gap:8px;flex-wrap:wrap;margin-bottom:10px"></div>
          <div class="row" style="align-items:center;justify-content:space-between">
            <div>Предпросмотр: <span id="tagPreview" class="tag"></span></div>
            <button class="btn primary" id="buyTagBtn">Сохранить тег</button>
          </div>
          <div class="muted small" style="margin-top:8px">Платный контент: кастомный тег доступен для Premium/админов.</div>
        </div>

        <div class="section-title">Чёрный список</div>
        <div class="row" style="margin-bottom:10px"><input id="blockInput" placeholder="username для блокировки" style="flex:1;background:rgba(0,0,0,.12);border:1px solid var(--line);border-radius:12px;padding:10px 12px;color:inherit"><button class="btn danger" id="blockAdd">Блокировать</button></div>
        <div id="blockList" class="list"></div>
      </div>
      <div class="modal-f">
        <button class="btn ghost" id="logoutBtn2">Выйти</button>
        <div style="flex:1"></div>
        <button class="btn ghost" data-close>Закрыть</button>
        <button class="btn primary" id="saveProfileBtn">Сохранить профиль</button>
      </div>
    `);

    $('#setDisplayName').value = me.displayName || '';
    $('#setUsername').value = me.username || '';
    $('#setBio').value = me.bio || '';
    $('#bioCount').textContent = String((me.bio||'').length);
    $('#setStatus').value = me.customStatus || '';
    $('#setStatusEmoji').value = me.customStatusEmoji || '';
    $('#setPresence').value = ['online','dnd','away','invisible'].includes(me.presence) ? me.presence : 'online';
    $('#privOnline').value = me.privacy?.online || 'all';
    $('#privAvatar').value = me.privacy?.avatar || 'all';
    $('#privLast').value = me.privacy?.lastSeen || 'all';
    setAvatar($('#setAvatar'), me); $('#setHeroName').textContent = me.displayName; $('#setHeroUser').textContent = '@'+me.username;
    renderBannerPreview();

    $('#setBio').addEventListener('input', e => $('#bioCount').textContent = String(e.target.value.length));
    const grads = { sunset:'linear-gradient(135deg,#ff7a59,#ffb347)', ocean:'linear-gradient(135deg,#2193b0,#6dd5ed)', violet:'linear-gradient(135deg,#7f7fd5,#86a8e7,#91eae4)', forest:'linear-gradient(135deg,#134e5e,#71b280)', rose:'linear-gradient(135deg,#ec008c,#fc6767)' };
    const gwrap = $('#bannerGradients');
    Object.entries(grads).forEach(([k,v]) => { const b=document.createElement('button'); b.className='chip'+(me.bannerGradient===k?' active':''); b.textContent=k; b.style.background=v; b.style.color='#fff'; b.style.borderColor='transparent'; b.onclick=async()=>{ me.bannerGradient=k; $$('.chip',gwrap).forEach(x=>x.classList.remove('active')); b.classList.add('active'); renderBannerPreview(); await savePrefs({bannerGradient:k}); }; gwrap.appendChild(b); });

    const accents=['#5b8cff','#22c55e','#f59e0b','#ef4444','#8b5cf6','#14b8a6','#ec4899'];
    const arow=$('#accentRow');
    accents.forEach(c=>{ const s=document.createElement('button'); s.className='swatch'+(me.accentColor===c?' active':''); s.style.background=c; s.onclick=()=>pickAccent(c); arow.appendChild(s); });
    const cp=document.createElement('input'); cp.type='color'; cp.className='color-picker'; cp.value=me.accentColor||'#5b8cff'; cp.oninput=e=>pickAccent(e.target.value); arow.appendChild(cp);
    function pickAccent(c){ me.accentColor=c; $$('.swatch',arow).forEach(x=>x.classList.remove('active')); [...$$('.swatch',arow)].find(x=>rgbToHex(x.style.background)===c.toLowerCase())?.classList.add('active'); cp.value=c; applyPrefs(); savePrefs({accentColor:c}); }

    const bwrap=$('#bubbleStyles');
    [['rounded','Скруглённые'],['sharp','Острые'],['minimal','Минимал']].forEach(([k,label])=>{ const b=document.createElement('button'); b.className='chip'+(me.bubbleStyle===k?' active':''); b.textContent=label; b.onclick=()=>{ me.bubbleStyle=k; $$('.chip',bwrap).forEach(x=>x.classList.remove('active')); b.classList.add('active'); $('#stylePreview').className=`preview-bubbles style-${k}`; applyPrefs(); savePrefs({bubbleStyle:k}); }; bwrap.appendChild(b); });

    const twrap=$('#themeChips');
    [['dark','Тёмная'],['light','Светлая'],['system','Системная']].forEach(([k,label])=>{ const b=document.createElement('button'); b.className='chip'+(me.theme===k?' active':''); b.textContent=label; b.onclick=()=>{ me.theme=k; $$('.chip',twrap).forEach(x=>x.classList.remove('active')); b.classList.add('active'); applyPrefs(); savePrefs({theme:k}); }; twrap.appendChild(b); });

    setupAvatarEditor();
    $('#bannerPick').onclick=()=>$('#bannerFile').click();
    $('#bannerFile').onchange=async e=>{ const f=e.target.files[0]; if(f) await uploadBanner(f); e.target.value=''; };
    $('#saveProfileBtn').onclick=saveProfile;
    $('#logoutBtn2').onclick=()=>{ closeModal(); logout(); };
    $('#blockAdd').onclick=addBlock;
    loadBlocks();
  }

  function renderBannerPreview() {
    const el=$('#setBanner'); if(!el) return; const me=state.me;
    const grads={sunset:'linear-gradient(135deg,#ff7a59,#ffb347)',ocean:'linear-gradient(135deg,#2193b0,#6dd5ed)',violet:'linear-gradient(135deg,#7f7fd5,#86a8e7,#91eae4)',forest:'linear-gradient(135deg,#134e5e,#71b280)',rose:'linear-gradient(135deg,#ec008c,#fc6767)'};
    if(me.bannerUrl){ el.style.backgroundImage=`url(${me.bannerUrl})`; el.style.backgroundSize='cover'; }
    else { el.style.backgroundImage=grads[me.bannerGradient]||grads.sunset; }
  }
  function rgbToHex(rgb){ const m=String(rgb).match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/); if(!m) return String(rgb).toLowerCase(); return '#'+[m[1],m[2],m[3]].map(x=>Number(x).toString(16).padStart(2,'0')).join(''); }
  async function savePrefs(patch){ try { const d=await api('/api/me',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({preferences:patch})}); state.me={...state.me,...d.user}; applyPrefs(); renderMe(); } catch(e){ toast(e.message,'err'); } }
  async function saveProfile(){
    const body={ profile:{ displayName:$('#setDisplayName').value.trim(), username:$('#setUsername').value.trim(), bio:$('#setBio').value.trim(), customStatus:$('#setStatus').value.trim(), customStatusEmoji:$('#setStatusEmoji').value.trim() }, privacy:{ online:$('#privOnline').value, avatar:$('#privAvatar').value, lastSeen:$('#privLast').value }, presence:$('#setPresence').value };
    try { const d=await api('/api/me',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}); state.me={...state.me,...d.user}; applyPrefs(); renderMe(); renderChatList(); toast('Профиль сохранён','ok'); } catch(e){ toast(e.message,'err'); }
  }

  // Avatar editor
  let avatarFileObj=null, avatarState={zoom:1,x:0,y:0,imgW:0,imgH:0};
  function setupAvatarEditor(){
    $('#avatarPick').onclick=()=>$('#avatarFile').click();
    $('#avatarFile').onchange=e=>{ const f=e.target.files[0]; if(f) loadAvatarFile(f); e.target.value=''; };
    $('#avatarZoom').oninput=e=>{ avatarState.zoom=parseFloat(e.target.value); applyAvatarTransform(); };
    $('#avatarX').oninput=e=>{ avatarState.x=parseInt(e.target.value,10); applyAvatarTransform(); };
    $('#avatarY').oninput=e=>{ avatarState.y=parseInt(e.target.value,10); applyAvatarTransform(); };
    $('#avatarSave').onclick=saveAvatar;
    $('#avatarReset').onclick=resetAvatar;
    const crop=$('#avatarCrop'); let drag=null;
    crop.addEventListener('pointerdown',e=>{ drag={sx:e.clientX,sy:e.clientY,ox:avatarState.x,oy:avatarState.y}; crop.setPointerCapture(e.pointerId); });
    crop.addEventListener('pointermove',e=>{ if(!drag) return; avatarState.x=Math.max(-100,Math.min(100,drag.ox+(e.clientX-drag.sx)/2)); avatarState.y=Math.max(-100,Math.min(100,drag.oy+(e.clientY-drag.sy)/2)); $('#avatarX').value=avatarState.x; $('#avatarY').value=avatarState.y; applyAvatarTransform(); });
    crop.addEventListener('pointerup',()=>drag=null);
  }
  function loadAvatarFile(file){
    const allowed=['image/jpeg','image/png','image/webp','image/gif'];
    const okType=allowed.includes(file.type)||/\.(jpe?g|png|webp|gif)$/i.test(file.name);
    if(!okType){ toast('Разрешены только JPEG, PNG, WebP, GIF','err'); return; }
    if(file.size > 5*1024*1024){ toast(`Файл слишком большой: ${fmtBytes(file.size)}. Лимит: 5 МБ.`,'err'); $('#avatarHint').innerHTML=`<span style="color:var(--danger)">Файл ${fmtBytes(file.size)} превышает лимит 5 МБ</span>`; return; }
    avatarFileObj=file; $('#avatarHint').textContent=`Выбран файл: ${file.name} (${fmtBytes(file.size)})`;
    const url=URL.createObjectURL(file); const img=$('#avatarCropImg');
    img.onload=()=>{ avatarState.imgW=img.naturalWidth; avatarState.imgH=img.naturalHeight; avatarState.zoom=1; avatarState.x=0; avatarState.y=0; $('#avatarZoom').value=1; $('#avatarX').value=0; $('#avatarY').value=0; applyAvatarTransform(); };
    img.src=url;
  }
  function applyAvatarTransform(){
    const img=$('#avatarCropImg'); if(!img.src || !avatarState.imgW) return;
    const box=180; const base=Math.max(box/avatarState.imgW, box/avatarState.imgH); const scale=base*avatarState.zoom;
    const w=avatarState.imgW*scale, h=avatarState.imgH*scale;
    img.style.width=w+'px'; img.style.height=h+'px';
    img.style.transform=`translate(calc(-50% + ${avatarState.x}px), calc(-50% + ${avatarState.y}px))`;
  }
  async function getAvatarBlobForUpload(){
    if(!avatarFileObj) throw new Error('Сначала выберите файл');
    if(avatarFileObj.type==='image/gif' || /\.gif$/i.test(avatarFileObj.name)) return avatarFileObj;
    const img=$('#avatarCropImg'); if(!img.naturalWidth) return avatarFileObj;
    const size=512, canvas=document.createElement('canvas'); canvas.width=size; canvas.height=size;
    const ctx=canvas.getContext('2d'); const box=180; const base=Math.max(box/avatarState.imgW, box/avatarState.imgH); const scale=base*avatarState.zoom;
    const drawW=avatarState.imgW*scale*(size/box), drawH=avatarState.imgH*scale*(size/box);
    const cx=size/2 + avatarState.x*(size/box), cy=size/2 + avatarState.y*(size/box);
    ctx.fillStyle='#111'; ctx.fillRect(0,0,size,size);
    ctx.drawImage(img, cx-drawW/2, cy-drawH/2, drawW, drawH);
    const type = avatarFileObj.type==='image/png' ? 'image/png' : (avatarFileObj.type==='image/webp' ? 'image/webp' : 'image/jpeg');
    const blob = await new Promise(r=>canvas.toBlob(r,type,0.92));
    return new File([blob], avatarFileObj.name.replace(/\.[^.]+$/, type==='image/png'?'.png':type==='image/webp'?'.webp':'.jpg'), {type});
  }
  async function saveAvatar(){
    try {
      const blob=await getAvatarBlobForUpload();
      if(blob.size > 5*1024*1024){ toast(`После обработки файл ${fmtBytes(blob.size)} > 5 МБ`,'err'); return; }
      const d=await uploadBinary(`/api/avatar/${encodeURIComponent(state.me.username)}`, blob, blob.name||'avatar.png', blob.type||'image/png');
      state.me={...state.me,...d.user}; setAvatar($('#setAvatar'),state.me); setAvatar($('#myAvatar'),state.me); renderChatList(); renderHeader(); toast('Аватар обновлён','ok');
    } catch(e){ toast(e.message,'err'); }
  }
  async function resetAvatar(){
    try { const d=await api(`/api/avatar/${encodeURIComponent(state.me.username)}`,{method:'DELETE'}); state.me={...state.me,...d.user}; avatarFileObj=null; $('#avatarCropImg').removeAttribute('src'); setAvatar($('#setAvatar'),state.me); setAvatar($('#myAvatar'),state.me); renderChatList(); renderHeader(); toast('Аватар сброшен','ok'); }
    catch(e){ toast(e.message,'err'); }
  }
  async function uploadBanner(file){
    if(file.size > 8*1024*1024) return toast(`Баннер слишком большой: ${fmtBytes(file.size)}. Лимит 8 МБ`,'err');
    try { const d=await uploadBinary(`/api/banner/${encodeURIComponent(state.me.username)}`, file, file.name, file.type); state.me={...state.me,...d.user}; renderBannerPreview(); toast('Баннер обновлён','ok'); }
    catch(e){ toast(e.message,'err'); }
  }
  function uploadBinary(url,file,name,type){
    return new Promise((resolve,reject)=>{ const xhr=new XMLHttpRequest(); xhr.open('POST',url); xhr.withCredentials=true; xhr.setRequestHeader('X-File-Name',encodeURIComponent(name||'file')); xhr.setRequestHeader('X-File-Type',type||'application/octet-stream'); xhr.onload=()=>{ if(xhr.status>=200&&xhr.status<300){ try{resolve(JSON.parse(xhr.responseText));}catch{resolve({});} } else { let msg='Ошибка'; try{msg=JSON.parse(xhr.responseText).error||msg;}catch{} reject(new Error(msg)); } }; xhr.onerror=()=>reject(new Error('Ошибка сети')); xhr.send(file); });
  }

  async function loadBlocks(){ try { const d=await api('/api/blocks'); const root=$('#blockList'); root.innerHTML=''; if(!d.blocks.length){ root.innerHTML='<div class="muted small">Список пуст</div>'; return; } for(const b of d.blocks){ const item=document.createElement('div'); item.className='list-item'; item.innerHTML=`<div class="li-meta"><div class="li-title">${escapeHTML(b.display_name)}</div><div class="li-sub">@${escapeHTML(b.username)}</div></div>`; const btn=document.createElement('button'); btn.className='btn ghost'; btn.textContent='Разблокировать'; btn.onclick=async()=>{ try{ await api('/api/blocks',{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:b.username})}); loadBlocks(); }catch(e){toast(e.message,'err');} }; item.appendChild(btn); root.appendChild(item); } } catch {} }
  async function addBlock(){ const username=$('#blockInput').value.trim().replace(/^@/,''); if(!username) return; try { await api('/api/blocks',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username})}); $('#blockInput').value=''; loadBlocks(); toast('Пользователь заблокирован','ok'); } catch(e){ toast(e.message,'err'); } }
  function openNewChat(){
    openModal(`
      <div class="modal-h"><h3>Создать / найти</h3><button class="icon-btn" data-close>✕</button></div>
      <div class="modal-b">
        <div class="section-title">Личный чат</div>
        <label class="field"><span>Username</span><input id="dmUsername" placeholder="например, alice"></label>
        <div class="row"><button class="btn primary" id="dmCreate">Начать чат</button></div>

        <div class="section-title">Групповая беседа</div>
        <label class="field"><span>Название группы</span><input id="grpTitle" maxlength="60"></label>
        <label class="field"><span>Описание</span><input id="grpDesc" maxlength="200" placeholder="О чём эта группа?"></label>
        <label class="field"><span>Username группы (опционально)</span><input id="grpUsername" maxlength="24" placeholder="my_group"></label>
        <label class="field"><span>Участники (username через запятую)</span><input id="grpMembers" placeholder="alice, bob"></label>
        <label class="field"><span><input id="grpPublic" type="checkbox"> Публичная группа (можно найти и вступить)</span></label>
        <div class="row"><button class="btn primary" id="grpCreate">Создать группу</button></div>

        <div class="section-title">Канал</div>
        <label class="field"><span>Название канала</span><input id="chTitle" maxlength="60"></label>
        <label class="field"><span>Описание</span><input id="chDesc" maxlength="200" placeholder="О чём канал?"></label>
        <label class="field"><span>Username канала</span><input id="chUsername" maxlength="24" placeholder="my_channel"></label>
        <label class="field"><span><input id="chPublic" type="checkbox" checked> Публичный канал</span></label>
        <div class="row"><button class="btn primary" id="chCreate">Создать канал</button></div>

        <div class="section-title">Публичные группы и каналы</div>
        <div class="row" style="margin-bottom:10px"><button class="btn ghost" id="discoverBtn">Обновить список</button></div>
        <div id="discoverList" class="list"></div>
      </div>`, {size:''});
    $('#dmCreate').onclick=async()=>{ const username=$('#dmUsername').value.trim().replace(/^@/,''); if(!username) return; try { const d=await api('/api/chats',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:'dm',username})}); upsertChat(d.chat); renderChatList(); closeModal(); openChat(d.chat.id); } catch(e){ toast(e.message,'err'); } };
    $('#grpCreate').onclick=async()=>{ const title=$('#grpTitle').value.trim(); const description=$('#grpDesc').value.trim(); const username=$('#grpUsername').value.trim().replace(/^@/,''); const members=$('#grpMembers').value.split(',').map(s=>s.trim()).filter(Boolean); const isPublic=$('#grpPublic').checked; try { const d=await api('/api/chats',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:'group',title,description,username,members,isPublic})}); upsertChat(d.chat); renderChatList(); closeModal(); openChat(d.chat.id); } catch(e){ toast(e.message,'err'); } };
    $('#chCreate').onclick=async()=>{ const title=$('#chTitle').value.trim(); const description=$('#chDesc').value.trim(); const username=$('#chUsername').value.trim().replace(/^@/,''); const isPublic=$('#chPublic').checked; try { const d=await api('/api/chats',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:'channel',title,description,username,isPublic,members:[]})}); upsertChat(d.chat); renderChatList(); closeModal(); openChat(d.chat.id); } catch(e){ toast(e.message,'err'); } };
    $('#discoverBtn').onclick=loadDiscover;
    loadDiscover();
  }

  async function loadDiscover(){
    const root = $('#discoverList'); if(!root) return;
    root.innerHTML = '<div class="muted small">Загрузка...</div>';
    try {
      const d = await api('/api/chats/discover');
      if(!d.chats.length){ root.innerHTML = '<div class="muted small">Пока нет публичных чатов для вступления</div>'; return; }
      root.innerHTML='';
      for(const c of d.chats){
        const item=document.createElement('div'); item.className='list-item';
        item.innerHTML = `<div class="li-meta"><div class="li-title">${escapeHTML(c.title)} <span class="muted small">(${c.type==='channel'?'канал':'группа'})</span></div><div class="li-sub">${c.username?('@'+escapeHTML(c.username)+' • '):''}${escapeHTML(c.description||'Без описания')}</div></div>`;
        const btn=document.createElement('button'); btn.className='btn primary'; btn.textContent='Вступить';
        btn.onclick=async()=>{ try{ const r=await api(`/api/chats/${encodeURIComponent(c.id)}/join`,{method:'POST'}); upsertChat(r.chat); renderChatList(); toast('Вы вступили','ok'); loadDiscover(); }catch(e){ toast(e.message,'err'); } };
        item.appendChild(btn); root.appendChild(item);
      }
    } catch(e){ root.innerHTML = '<div class="muted small">Ошибка загрузки</div>'; }
  }
    // --- Calls (WebRTC signaling via WS) ---
  let activeCall = null;
  function closeCallUI(){ if(activeCall?.wrap) activeCall.wrap.remove(); if(activeCall?.localStream) activeCall.localStream.getTracks().forEach(t=>t.stop()); if(activeCall?.pc) { try{activeCall.pc.close();}catch{} } activeCall=null; }
  function renderCallUI(peer, video, status){
    closeCallUI();
    const wrap=document.createElement('div'); wrap.className='call-overlay';
    wrap.innerHTML=`<div class="call-card"><div id="callAv" class="avatar"></div><h3>${escapeHTML(peer.displayName||peer.username||'Звонок')}</h3><p id="callStatus">${escapeHTML(status||'Подключение...')}</p>
      <div class="call-media"><video id="callRemote" autoplay playsinline class="call-video ${video?'':'hidden'}"></video><video id="callLocal" autoplay playsinline muted class="call-video local ${video?'':'hidden'}"></video></div>
      <div class="call-controls"><button class="call-btn" id="callMic" title="Микрофон">🎙</button><button class="call-btn ${video?'':'off'}" id="callCam" title="Камера">📷</button><button class="call-btn end" id="callEnd" title="Завершить">✕</button></div></div>`;
    document.body.appendChild(wrap); setAvatar($('#callAv',wrap), peer);
    return wrap;
  }
  async function ensureMedia(video){
    try { return await navigator.mediaDevices.getUserMedia({ audio:true, video: video ? { width:{ideal:1280}, height:{ideal:720} } : false }); }
    catch(e){ if(video) { try { return await navigator.mediaDevices.getUserMedia({ audio:true, video:false }); } catch{} } throw e; }
  }
  function bindCallControls(){
    const c=activeCall; if(!c) return;
    $('#callEnd',c.wrap).onclick=()=>{ wsSend({type:'call_end',to:c.peerId}); closeCallUI(); };
    $('#callMic',c.wrap).onclick=()=>{ const t=c.localStream?.getAudioTracks()[0]; if(!t) return; t.enabled=!t.enabled; $('#callMic',c.wrap).classList.toggle('off',!t.enabled); };
    $('#callCam',c.wrap).onclick=()=>{ const t=c.localStream?.getVideoTracks()[0]; if(!t) return toast('Видео недоступно','err'); t.enabled=!t.enabled; $('#callCam',c.wrap).classList.toggle('off',!t.enabled); };
  }
  async function startCall(video){
    const chat=state.chats.find(c=>c.id===state.activeChatId); if(!chat) return;
    if(chat.type!=='dm' || !chat.peer) return toast('Звонки доступны в личных чатах','err');
    if(activeCall) return toast('Уже идёт звонок','err');
    const peer=chat.peer;
    const wrap=renderCallUI(peer, video, video?'Видеозвонок • вызываем...':'Аудиозвонок • вызываем...');
    try {
      const localStream=await ensureMedia(video);
      const pc=new RTCPeerConnection({ iceServers:[{urls:['stun:stun.l.google.com:19302']}] });
      activeCall={pc,localStream,peerId:peer.id,video,wrap,role:'caller'};
      localStream.getTracks().forEach(t=>pc.addTrack(t,localStream));
      const lv=$('#callLocal',wrap); if(lv){ lv.srcObject=localStream; lv.classList.toggle('hidden',!localStream.getVideoTracks().length); }
      pc.ontrack=(e)=>{ const rv=$('#callRemote',wrap); if(rv){ rv.srcObject=e.streams[0]; rv.classList.toggle('hidden',!e.streams[0]?.getVideoTracks().length); } const st=$('#callStatus',wrap); if(st) st.textContent='Соединено'; };
      pc.onicecandidate=(e)=>{ if(e.candidate) wsSend({type:'call_ice',to:peer.id,candidate:e.candidate}); };
      pc.onconnectionstatechange=()=>{ if(['failed','disconnected','closed'].includes(pc.connectionState)) { const st=$('#callStatus',wrap); if(st) st.textContent='Соединение потеряно'; setTimeout(closeCallUI,1200); } };
      bindCallControls();
      const offer=await pc.createOffer(); await pc.setLocalDescription(offer);
      wsSend({type:'call_offer',to:peer.id,video,offer});
    } catch(e){ toast(e.message||'Не удалось начать звонок','err'); closeCallUI(); }
  }

  function incomingCall(msg){
    if(activeCall){ wsSend({type:'call_busy',to:msg.from}); return; }
    const peer = msg.fromUser || {displayName:'Пользователь',username:'',id:msg.from};
    const wrap=document.createElement('div'); wrap.className='call-overlay';
    wrap.innerHTML=`<div class="call-card"><div id="callAv" class="avatar"></div><h3>${escapeHTML(peer.displayName||'Входящий звонок')}</h3><p id="callStatus">${msg.video?'Видеозвонок':'Аудиозвонок'}</p>
      <div class="call-controls"><button class="call-btn" id="callAccept">✓</button><button class="call-btn end" id="callReject">✕</button></div></div>`;
    document.body.appendChild(wrap); setAvatar($('#callAv',wrap), peer);
    $('#callReject',wrap).onclick=()=>{ wsSend({type:'call_reject',to:msg.from}); wrap.remove(); };
    $('#callAccept',wrap).onclick=async()=>{
      wrap.remove();
      const callWrap=renderCallUI(peer, !!msg.video, 'Подключение...');
      try {
        const localStream=await ensureMedia(!!msg.video);
        const pc=new RTCPeerConnection({ iceServers:[{urls:['stun:stun.l.google.com:19302']}] });
        activeCall={pc,localStream,peerId:msg.from,video:!!msg.video,wrap:callWrap,role:'callee'};
        localStream.getTracks().forEach(t=>pc.addTrack(t,localStream));
        const lv=$('#callLocal',callWrap); if(lv){ lv.srcObject=localStream; lv.classList.toggle('hidden',!localStream.getVideoTracks().length); }
        pc.ontrack=(e)=>{ const rv=$('#callRemote',callWrap); if(rv){ rv.srcObject=e.streams[0]; rv.classList.toggle('hidden',!e.streams[0]?.getVideoTracks().length); } const st=$('#callStatus',callWrap); if(st) st.textContent='Соединено'; };
        pc.onicecandidate=(e)=>{ if(e.candidate) wsSend({type:'call_ice',to:msg.from,candidate:e.candidate}); };
        pc.onconnectionstatechange=()=>{ if(['failed','disconnected','closed'].includes(pc.connectionState)) { const st=$('#callStatus',callWrap); if(st) st.textContent='Соединение потеряно'; setTimeout(closeCallUI,1200); } };
        bindCallControls();
        await pc.setRemoteDescription(new RTCSessionDescription(msg.offer));
        const answer=await pc.createAnswer(); await pc.setLocalDescription(answer);
        wsSend({type:'call_answer',to:msg.from,answer});
      } catch(e){ toast(e.message||'Не удалось принять звонок','err'); wsSend({type:'call_reject',to:msg.from}); closeCallUI(); }
    };
  }

  async function handleCallSignal(msg){
    if(msg.type==='call_offer') return incomingCall(msg);
    if(!activeCall || msg.from!==activeCall.peerId) return;
    const c=activeCall;
    try {
      if(msg.type==='call_answer'){ await c.pc.setRemoteDescription(new RTCSessionDescription(msg.answer)); const st=$('#callStatus',c.wrap); if(st) st.textContent='Соединено'; }
      if(msg.type==='call_ice' && msg.candidate){ try{ await c.pc.addIceCandidate(new RTCIceCandidate(msg.candidate)); }catch{} }
      if(msg.type==='call_reject'){ toast('Звонок отклонён','err'); closeCallUI(); }
      if(msg.type==='call_busy'){ toast('Пользователь занят','err'); closeCallUI(); }
      if(msg.type==='call_end'){ toast('Звонок завершён','ok'); closeCallUI(); }
    } catch(e){ console.error(e); }
  }

function openModal(html, opts={}){
    closeModal(); const root=$('#modalRoot'); const bd=document.createElement('div'); bd.className='modal-backdrop';
    bd.innerHTML=`<div class="modal ${opts.size||''}">${html}</div>`;
    bd.addEventListener('click',e=>{ if(e.target===bd) closeModal(); });
    bd.querySelectorAll('[data-close]').forEach(b=>b.addEventListener('click', closeModal));
    root.appendChild(bd); return bd;
  }
  function closeModal(){ $('#modalRoot').innerHTML=''; }
  const emojis=['😀','😁','😂','🤣','😊','😍','😎','🤔','😢','😡','👍','👎','🙏','👏','🔥','🎉','❤️','✅','👀','💯','🤝','✨','💡','📎','🎧','🚀','☕','🌙'];
  function toggleEmoji(){
    const existing=$('.emoji-pop'); if(existing){ existing.remove(); return; }
    const pop=document.createElement('div'); pop.className='emoji-pop';
    emojis.forEach(e=>{ const b=document.createElement('button'); b.type='button'; b.textContent=e; b.onclick=()=>{ insertEmoji(e); pop.remove(); }; pop.appendChild(b); });
    $('.composer').style.position='relative'; $('.composer').appendChild(pop);
    setTimeout(()=>document.addEventListener('click', function handler(ev){ if(!pop.contains(ev.target)&&ev.target!==$('#emojiBtn')){ pop.remove(); document.removeEventListener('click', handler); } }), 0);
  }
  function insertEmoji(e){ const i=$('#messageInput'); const s=i.selectionStart,v=i.value; i.value=v.slice(0,s)+e+v.slice(i.selectionEnd); i.focus(); i.selectionStart=i.selectionEnd=s+e.length; autoGrow(i); }
  function autoGrow(el){ el.style.height='auto'; el.style.height=Math.min(160, el.scrollHeight)+'px'; }
  let mediaRec=null, recChunks=[];
  async function toggleVoice(){
    if(mediaRec && mediaRec.state==='recording'){ mediaRec.stop(); $('#voiceBtn').style.color=''; return; }
    if(!navigator.mediaDevices?.getUserMedia) return toast('Запись голоса не поддерживается в этом браузере','err');
    try {
      const stream=await navigator.mediaDevices.getUserMedia({audio:true});
      recChunks=[]; mediaRec=new MediaRecorder(stream);
      mediaRec.ondataavailable=e=>{ if(e.data.size) recChunks.push(e.data); };
      mediaRec.onstop=async()=>{ stream.getTracks().forEach(t=>t.stop()); const blob=new Blob(recChunks,{type:mediaRec.mimeType||'audio/webm'}); const file=new File([blob],`voice-${Date.now()}.webm`,{type:blob.type}); await handleFile(file,'voice'); };
      mediaRec.start(); $('#voiceBtn').style.color='var(--danger)'; toast('Запись... нажмите ещё раз для отправки','ok');
    } catch { toast('Не удалось получить доступ к микрофону','err'); }
  }
  function bindEvents(){
    $$('.seg').forEach(btn=>btn.addEventListener('click',()=>{ $$('.seg').forEach(b=>b.classList.remove('active')); btn.classList.add('active'); const tab=btn.dataset.auth; $('#loginForm').classList.toggle('hidden',tab!=='login'); $('#registerForm').classList.toggle('hidden',tab!=='register'); }));
    $('#loginForm').addEventListener('submit', async e=>{ e.preventDefault(); $('#loginError').textContent=''; const fd=new FormData(e.target); try { const d=await api('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:fd.get('username'),password:fd.get('password')})}); state.me=d.user; await bootApp(); } catch(err){ $('#loginError').textContent=err.message; } });
    $('#registerForm').addEventListener('submit', async e=>{ e.preventDefault(); $('#registerError').textContent=''; const fd=new FormData(e.target); try { const d=await api('/api/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({displayName:fd.get('displayName'),username:fd.get('username'),password:fd.get('password')})}); state.me=d.user; await bootApp(); } catch(err){ $('#registerError').textContent=err.message; } });
    $('#myProfileBtn').onclick=openSettings; $('#settingsBtn').onclick=openSettings; $('#newChatBtn').onclick=openNewChat; $('#adminBtn').onclick=openAdminPanel;
    $('#backBtn').onclick=()=>$('#appView').classList.remove('mobile-chat');
    $('#chatPeerBtn').onclick=()=>{ const c=state.chats.find(x=>x.id===state.activeChatId); if(c?.type==='dm'&&c.peer) openUserCard(c.peer); else if(c) openGroupCard(c); };
    $('#chatMenuBtn').onclick=(e)=>{ e.preventDefault(); e.stopPropagation(); openChatMenu(e); };
    $('#audioCallBtn').onclick=()=>startCall(false); $('#videoCallBtn').onclick=()=>startCall(true);
    $('#chatSearch').addEventListener('input',e=>{ state.search=e.target.value; renderChatList(); });
    $('#attachBtn').onclick=()=>$('#fileInput').click(); $('#fileInput').onchange=e=>{ const f=e.target.files[0]; if(f) handleFile(f); e.target.value=''; };
    $('#emojiBtn').onclick=e=>{ e.preventDefault(); toggleEmoji(); };
    $('#voiceBtn').onclick=toggleVoice;
    $('#replyCancel').onclick=()=>{ state.replyTo=null; state.editing=null; renderReplyBar(); $('#messageInput').value=''; };
    $('#composer').addEventListener('submit',e=>{ e.preventDefault(); sendMessage(); });
    $('#messageInput').addEventListener('input',e=>{ autoGrow(e.target); sendTyping(); });
    $('#messageInput').addEventListener('keydown',e=>{ if(e.key==='Enter'&&!e.shiftKey){ e.preventDefault(); sendMessage(); } });
    window.addEventListener('resize',()=>{ if(innerWidth>760) $('#appView').classList.remove('mobile-chat'); });
  }
  let typingSentAt=0;
  function sendTyping(){ if(!state.activeChatId) return; const now=Date.now(); if(now-typingSentAt<1500) return; typingSentAt=now; wsSend({type:'typing',chatId:state.activeChatId,typing:true}); setTimeout(()=>wsSend({type:'typing',chatId:state.activeChatId,typing:false}),2000); }
  function openChatMenu(e){
    e?.preventDefault?.(); e?.stopPropagation?.();
    const existing = $('.ctx-menu'); if(existing){ existing.remove(); return; }
    const chat=state.chats.find(c=>c.id===state.activeChatId); if(!chat) return;
    const menu=document.createElement('div'); menu.className='ctx-menu';
    addCtx(menu,chat.pinned?'Открепить':'Закрепить',()=>toggleChatSetting(chat,'pinned',!chat.pinned));
    addCtx(menu,chat.muted?'Вкл. уведомления':'Отключить уведомления',()=>toggleChatSetting(chat,'muted',!chat.muted));
    if(chat.type==='dm'&&chat.peer) addCtx(menu,'Профиль',()=>openUserCard(chat.peer));
    if(chat.type!=='dm') addCtx(menu,'Инфо чата',()=>openGroupCard(chat));
    if(['owner','admin'].includes(chat.myRole) || state.me.isAdmin) addCtx(menu,'Управление',()=>openChatManage(chat));
    if(chat.type!=='dm') addCtx(menu,'Покинуть',async()=>{ try{ await api(`/api/chats/${encodeURIComponent(chat.id)}/leave`,{method:'POST'}); }catch(err){toast(err.message,'err');} }, true);
    const btn = e?.currentTarget || $('#chatMenuBtn');
    const r = btn.getBoundingClientRect();
    document.body.appendChild(menu);
    const mr = menu.getBoundingClientRect();
    menu.style.left = Math.min(r.right - mr.width, innerWidth - mr.width - 8) + 'px';
    menu.style.top = Math.min(r.bottom + 8, innerHeight - mr.height - 8) + 'px';
    setTimeout(()=>document.addEventListener('click', closeCtx,{once:true}),0);
  }
  async function toggleChatSetting(chat,key,val){ try { await api(`/api/chats/${encodeURIComponent(chat.id)}/settings`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({[key]:val})}); chat[key]=val; renderChatList(); } catch(e){ toast(e.message,'err'); } }

  function setupTagCustomizer(){
    const icons=['','⭐','🔥','💎','🎮','🎵','🚀','💜','⚡','👑','🛡️'];
    let selectedIcon = state.me?.tagIcon || '';
    const text=$('#tagText'), color=$('#tagColor'), preview=$('#tagPreview'), wrap=$('#tagIcons');
    if(!text||!color||!preview||!wrap) return;
    text.value = state.me?.tag || '';
    color.value = state.me?.tagColor || '#5b8cff';
    const renderIcons=()=>{ wrap.innerHTML=''; icons.forEach(ic=>{ const b=document.createElement('button'); b.type='button'; b.className='chip'+(selectedIcon===ic?' active':''); b.textContent=ic||'Нет'; b.onclick=()=>{ selectedIcon=ic; renderIcons(); renderPreview(); }; wrap.appendChild(b); }); };
    const renderPreview=()=>{ const t=text.value.trim()||'тег'; preview.textContent=(selectedIcon?selectedIcon+' ':'')+t; preview.style.background=color.value+'22'; preview.style.color=color.value; preview.style.borderColor=color.value+'55'; };
    text.oninput=renderPreview; color.oninput=renderPreview; renderIcons(); renderPreview();
    $('#buyTagBtn').onclick=async()=>{
      const tag=text.value.trim();
      if(!tag) return toast('Введите тег','err');
      try {
        const d = await api('/api/gifts/buy-tag',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({tag,color:color.value,icon:selectedIcon})});
        state.me = { ...state.me, ...d.user };
        applyPrefs(); renderMe();
        toast('Тег сохранён','ok');
      } catch(e){ toast(e.message,'err'); }
    };
  }
  function openUserCard(user){ const bg=user.bannerUrl?`background-image:url(${user.bannerUrl});background-size:cover;`:''; openModal(`<div class="modal-h"><h3>Профиль</h3><button class="icon-btn" data-close>✕</button></div><div class="modal-b"><div class="profile-hero"><div class="profile-banner" style="${bg}"></div><div class="profile-hero-body"><div id="ucAv" class="avatar"></div><div class="profile-hero-meta"><h4>${escapeHTML(user.displayName)}</h4><p>@${escapeHTML(user.username)}</p></div></div></div><div class="stack"><div><div class="field-label">О себе</div><div>${escapeHTML(user.bio||'Не указано')}</div></div><div><div class="field-label">Статус</div><div>${escapeHTML(((user.customStatusEmoji||'')+' '+(user.customStatus||'')).trim()||'—')}</div></div></div></div>`,{size:'sm'}); setAvatar($('#ucAv'),user); }
  function openGroupCard(chat){
    const kind = chat.type==='channel'?'Канал':'Группа';
    openModal(`<div class="modal-h"><h3>${escapeHTML(chat.title)}</h3><button class="icon-btn" data-close>✕</button></div>
      <div class="modal-b">
        <div class="muted small" style="margin-bottom:10px">${kind} • ${chat.isPublic?'публичный':'приватный'}${chat.username?' • @'+escapeHTML(chat.username):''}</div>
        <div style="margin-bottom:14px">${escapeHTML(chat.description||'Описание отсутствует')}</div>
        <div class="section-title">Участники (${(chat.members||[]).length})</div>
        <div class="list">${(chat.members||[]).map(m=>`<div class="list-item"><div class="avatar" style="width:36px;height:36px;font-size:.75rem">${m.avatarUrl?`<img src="${m.avatarUrl}" class="avatar-img">`:escapeHTML(initials(m.displayName))}</div><div class="li-meta"><div class="li-title">${escapeHTML(m.displayName)} ${m.role&&m.role!=='member'?'<span class="muted small">('+escapeHTML(m.role)+')</span>':''}</div><div class="li-sub">@${escapeHTML(m.username)}</div></div></div>`).join('')}</div>
      </div>`,{size:'sm'});
  }

  function openChatManage(chat){
    openModal(`<div class="modal-h"><h3>Управление чатом</h3><button class="icon-btn" data-close>✕</button></div>
      <div class="modal-b stack">
        <label class="field"><span>Название</span><input id="mTitle" maxlength="60" value="${escapeHTML(chat.title||'')}"></label>
        <label class="field"><span>Описание</span><textarea id="mDesc" rows="3" maxlength="300">${escapeHTML(chat.description||'')}</textarea></label>
        <label class="field"><span>Username</span><input id="mUsername" maxlength="24" value="${escapeHTML(chat.username||'')}"></label>
        <label class="field"><span><input id="mPublic" type="checkbox" ${chat.isPublic?'checked':''}> Публичный</span></label>
        <div class="row"><button class="btn primary" id="mSave">Сохранить</button></div>
        <div class="section-title">Добавить участника</div>
        <div class="row"><input id="mAddUser" placeholder="username" style="flex:1;background:rgba(0,0,0,.12);border:1px solid var(--line);border-radius:12px;padding:10px 12px;color:inherit"><button class="btn" id="mAddBtn">Добавить</button></div>
        <div class="section-title">Участники</div>
        <div id="mMembers" class="list"></div>
      </div>`,{size:''});
    const renderMembers = ()=>{
      const root=$('#mMembers'); root.innerHTML='';
      (state.chats.find(c=>c.id===chat.id)?.members||chat.members||[]).forEach(m=>{
        const item=document.createElement('div'); item.className='list-item';
        item.innerHTML=`<div class="li-meta"><div class="li-title">${escapeHTML(m.displayName)}</div><div class="li-sub">@${escapeHTML(m.username)} • ${escapeHTML(m.role||'member')}</div></div>`;
        if(m.id!==state.me.id && m.role!=='owner'){
          const btn=document.createElement('button'); btn.className='btn danger'; btn.textContent='Удалить';
          btn.onclick=async()=>{ try{ await api(`/api/chats/${encodeURIComponent(chat.id)}/members/${encodeURIComponent(m.id)}`,{method:'DELETE'}); toast('Участник удалён','ok'); await loadChat(chat.id); renderMembers(); renderChatList(); }catch(e){toast(e.message,'err');} };
          item.appendChild(btn);
        }
        root.appendChild(item);
      });
    };
    renderMembers();
    $('#mSave').onclick=async()=>{ try{ const d=await api(`/api/chats/${encodeURIComponent(chat.id)}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:$('#mTitle').value.trim(), description:$('#mDesc').value.trim(), username:$('#mUsername').value.trim().replace(/^@/,''), isPublic:$('#mPublic').checked})}); upsertChat(d.chat); renderChatList(); renderHeader(); toast('Сохранено','ok'); }catch(e){toast(e.message,'err');} };
    $('#mAddBtn').onclick=async()=>{ const username=$('#mAddUser').value.trim().replace(/^@/,''); if(!username) return; try{ await api(`/api/chats/${encodeURIComponent(chat.id)}/members`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username})}); $('#mAddUser').value=''; await loadChat(chat.id); renderMembers(); renderChatList(); toast('Участник добавлен','ok'); }catch(e){toast(e.message,'err');} };
  }


  async function loadUserGifts(userId, sel, canTransfer=false){
    const root=$(sel); if(!root) return;
    root.innerHTML='<span class="muted small">Загрузка...</span>';
    try {
      const d = await Promise.race([
        api(`/api/users/${encodeURIComponent(userId)}/gifts`),
        new Promise((_,rej)=>setTimeout(()=>rej(new Error('timeout')), 8000))
      ]);
      const gifts = d?.gifts || [];
      if(!gifts.length){ root.innerHTML='<span class="muted small">Пока нет подарков</span>'; return; }
      root.innerHTML=d.gifts.map(g=>`<div class="gift-card ${canTransfer?'transferable':''}" data-ugid="${g.id}" title="${escapeHTML(g.name)} от @${escapeHTML(g.from_username||g.fromUsername||'')}">
        <div class="gift-emoji" style="background:${g.bg||'linear-gradient(135deg,#5b8cff,#8b5cf6)'}">${g.emoji||'🎁'}</div>
        <div class="gift-name">${escapeHTML(g.name||'Подарок')}</div>
        <div class="muted small">от @${escapeHTML(g.from_username||g.fromUsername||'user')}</div>
        ${canTransfer?'<button class="btn ghost gift-transfer-btn">Передать</button>':''}
      </div>`).join('');
      if(canTransfer){
        root.querySelectorAll('.gift-transfer-btn').forEach(btn=>btn.onclick=async(e)=>{
          e.stopPropagation();
          const card = btn.closest('.gift-card');
          const ugid = card.dataset.ugid;
          const username = prompt('Кому передать подарок? Введите username:','');
          if(!username) return;
          try { await api('/api/gifts/transfer',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({userGiftId:ugid,username:username.trim().replace(/^@/,'')})}); toast('Подарок передан','ok'); loadUserGifts(userId, sel, true); }
          catch(err){ toast(err.message,'err'); }
        });
      }
    } catch(e) { console.error('loadUserGifts',e); root.innerHTML='<span class="muted small">Не удалось загрузить подарки</span>'; }
  }

  async function openGiftPicker(user){
    try {
      const d=await api('/api/gifts/catalog');
      openModal(`<div class="modal-h"><h3>Подарок для ${escapeHTML(user.displayName)}</h3><button class="icon-btn" data-close>✕</button></div>
        <div class="modal-b"><div class="gift-grid">${d.gifts.map(g=>`<button class="gift-pick" data-id="${g.id}"><div class="gift-emoji" style="background:${g.bg}">${g.emoji}</div><div class="gift-name">${escapeHTML(g.name)}</div><div class="muted small">${g.price} ⭐</div></button>`).join('')}</div>
        <label class="field" style="margin-top:12px"><span>Сообщение (опционально)</span><input id="giftMsg" maxlength="120" placeholder="Поздравляю!"></label></div>`,{size:'sm'});
      $('.gift-pick').forEach(btn=>btn.onclick=async()=>{
        try { await api('/api/gifts/send',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:user.username,giftId:btn.dataset.id,message:$('#giftMsg').value.trim()})}); toast('Подарок отправлен','ok'); closeModal(); }
        catch(e){ toast(e.message,'err'); }
      });
    } catch(e){ toast(e.message,'err'); }
  }
  async function openAdminPanel(){
    if(!state.me?.isAdmin) return toast('Нет доступа','err');
    openModal(`<div class="modal-h"><h3>Админ-панель</h3><button class="icon-btn" data-close>✕</button></div>
      <div class="modal-b admin-panel">
        <div class="admin-stats" id="admStats"><div class="muted small">Загрузка...</div></div>
        <div class="section-title">Выдать подарок</div>
        <div class="admin-gift-box">
          <div class="row"><input id="admGiftUser" placeholder="username получателя" style="flex:1;background:rgba(0,0,0,.12);border:1px solid var(--line);border-radius:12px;padding:10px 12px;color:inherit"><input id="admGiftMsg" placeholder="Сообщение" style="flex:1;background:rgba(0,0,0,.12);border:1px solid var(--line);border-radius:12px;padding:10px 12px;color:inherit"></div>
          <div id="admGiftCatalog" class="gift-grid small"></div>
        </div>
        <div class="section-title">Пользователи</div>
        <div id="admUsers" class="list"></div>
        <div class="section-title">Чаты / каналы</div>
        <div id="admChats" class="list"></div>
      </div>`,{size:''});
    try {
      const [stats, users, chats, catalog] = await Promise.all([api('/api/admin/stats'), api('/api/admin/users'), api('/api/admin/chats'), api('/api/gifts/catalog')]);
      $('#admStats').innerHTML = `
        <div class="stat-card"><div class="stat-num">${stats.stats.users}</div><div class="muted small">Пользователи</div></div>
        <div class="stat-card"><div class="stat-num">${stats.stats.chats}</div><div class="muted small">Чаты</div></div>
        <div class="stat-card"><div class="stat-num">${stats.stats.messages}</div><div class="muted small">Сообщения</div></div>`;
      const gc = $('#admGiftCatalog');
      gc.innerHTML = catalog.gifts.map(g=>`<button class="gift-pick adm-gift-pick" data-id="${g.id}"><div class="gift-emoji" style="background:${g.bg}">${g.emoji}</div><div class="gift-name">${escapeHTML(g.name)}</div></button>`).join('');
      gc.querySelectorAll('.adm-gift-pick').forEach(btn=>btn.onclick=async()=>{
        const username = $('#admGiftUser').value.trim().replace(/^@/,'') || state.me.username;
        const message = $('#admGiftMsg').value.trim();
        try { await api('/api/admin/gifts/give',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,giftId:btn.dataset.id,message})}); toast('Подарок выдан: @'+username,'ok'); }
        catch(e){ toast(e.message,'err'); }
      });
      const ur = $('#admUsers'); ur.innerHTML='';
      users.users.forEach(u=>{
        const item=document.createElement('div'); item.className='list-item';
        item.innerHTML=`<div class="li-meta"><div class="li-title">${escapeHTML(u.displayName)} ${u.isPremium?'⭐':''} ${u.isAdmin?'🛡️':''} ${u.isBanned?'⛔':''} ${u.tag?'<span class="tag">'+escapeHTML(u.tag)+'</span>':''}</div><div class="li-sub">@${escapeHTML(u.username)} ${u.bannedReason?('• '+escapeHTML(u.bannedReason)):''}</div></div>`;
        const actions=document.createElement('div'); actions.className='row';
        if(u.username.toLowerCase()!=='kompotmik2'){
          const adminBtn=document.createElement('button'); adminBtn.className='btn ghost'; adminBtn.textContent=u.isAdmin?'Снять админа':'Сделать админом';
          adminBtn.onclick=async()=>{ try{ await api('/api/admin/users/role',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:u.username,isAdmin:!u.isAdmin})}); toast('Роль обновлена','ok'); closeModal(); openAdminPanel(); }catch(e){toast(e.message,'err');} };
          const banBtn=document.createElement('button'); banBtn.className='btn danger'; banBtn.textContent=u.isBanned?'Разбанить':'Забанить';
          banBtn.onclick=async()=>{ const reason = u.isBanned ? '' : (prompt('Причина бана (опционально):','') || ''); try{ await api('/api/admin/users/ban',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:u.username,banned:!u.isBanned,reason})}); toast(u.isBanned?'Разбанен':'Забанен','ok'); closeModal(); openAdminPanel(); }catch(e){toast(e.message,'err');} };
          const premBtn=document.createElement('button'); premBtn.className='btn ghost'; premBtn.textContent=u.isPremium?'Снять Premium':'Выдать Premium';
          premBtn.onclick=async()=>{ try{ await api('/api/admin/users/premium',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:u.username,premium:!u.isPremium,days:30})}); toast('Premium обновлён','ok'); closeModal(); openAdminPanel(); }catch(e){toast(e.message,'err');} };
          const tagBtn=document.createElement('button'); tagBtn.className='btn ghost'; tagBtn.textContent='Тег';
          tagBtn.onclick=async()=>{ const tag=prompt('Тег (пусто = убрать):', u.tag||''); if(tag===null) return; try{ await api('/api/admin/users/tag',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:u.username,tag:tag.trim()})}); toast('Тег обновлён','ok'); closeModal(); openAdminPanel(); }catch(e){toast(e.message,'err');} };
          const giftBtn=document.createElement('button'); giftBtn.className='btn ghost'; giftBtn.textContent='🎁 Подарок';
          giftBtn.onclick=()=>{ $('#admGiftUser').value=u.username; $('#admGiftUser').scrollIntoView({behavior:'smooth',block:'center'}); toast('Выберите подарок сверху для @'+u.username,'ok'); };
          actions.appendChild(adminBtn); actions.appendChild(banBtn); actions.appendChild(premBtn); actions.appendChild(tagBtn); actions.appendChild(giftBtn);
        }
        item.appendChild(actions); ur.appendChild(item);
      });
      const cr=$('#admChats'); cr.innerHTML='';
      chats.chats.forEach(c=>{
        const item=document.createElement('div'); item.className='list-item';
        item.innerHTML=`<div class="li-meta"><div class="li-title">${escapeHTML(c.title||'DM')} <span class="muted small">(${escapeHTML(c.type)})</span></div><div class="li-sub">${c.username?('@'+escapeHTML(c.username)+' • '):''}${(c.members||[]).length} участников</div></div>`;
        if(c.type!=='dm'){
          const del=document.createElement('button'); del.className='btn danger'; del.textContent='Удалить';
          del.onclick=async()=>{ if(!confirm('Удалить чат/канал?')) return; try{ await api(`/api/admin/chats/${encodeURIComponent(c.id)}`,{method:'DELETE'}); toast('Удалено','ok'); closeModal(); openAdminPanel(); loadChats(); }catch(e){toast(e.message,'err');} };
          item.appendChild(del);
        }
        cr.appendChild(item);
      });
    } catch(e){ toast(e.message,'err'); }
  }
  async function logout(){ try{await api('/api/logout',{method:'POST'});}catch{} try{state.ws?.close();}catch{} state.ws=null; state.me=null; state.chats=[]; state.users=[]; state.messages.clear(); state.activeChatId=null; $('#appView').classList.remove('mobile-chat'); showAuth(); }
  async function bootApp(){ applyPrefs(); await loadUsers(); await loadChats(); showApp(); connectWS(); if('Notification' in window && Notification.permission==='default'){ try{await Notification.requestPermission();}catch{} } }
  async function init(){
    bindEvents();
    try {
      const d=await api('/api/me');
      state.me=d.user;
      await bootApp();
    } catch(e) {
      if (e && e.status === 401) { showAuth(); return; }
      console.error('init error', e);
      toast('Ошибка соединения. Проверьте сервер и обновите страницу.', 'err');
      showAuth();
    }
  }
  init();
})();
