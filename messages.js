(function () {
  'use strict';

  const CONVERSATIONS_KEY = 'nx_chat_conversations';
  const MESSAGES_KEY = 'nx_chat_messages';
  const shell = document.querySelector('.messages-shell');
  const session = NexovantaDB.Session.get();
  let selectedConversationId = null;
  let feedbackTimer;

  function readCollection(key) {
    try {
      const value = JSON.parse(localStorage.getItem(key) || '[]');
      return Array.isArray(value) ? value : [];
    } catch (error) {
      console.error(`Could not read ${key}:`, error);
      return [];
    }
  }

  async function saveCollection(key, records) {
    const saved = await NexovantaDB.syncCollection(key, records);
    if (!saved) throw new Error('Your message could not be saved. Check your connection and try again.');
  }

  function escapeHtml(value) {
    return String(value || '').replace(/[&<>"']/g, character => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[character]);
  }

  function initials(value) {
    return String(value || '?').trim().split(/\s+/).slice(0, 2).map(part => part[0] || '').join('').toUpperCase();
  }

  function getMembers(conversation) {
    return NexovantaDB.Users.getAll().filter(user => conversation.member_ids.includes(String(user.id)));
  }

  function displayName(user) {
    return user.full_name || `@${user.username}`;
  }

  function getMessages(conversationId) {
    return readCollection(MESSAGES_KEY)
      .filter(message => message.conversation_id === conversationId)
      .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  }

  function latestMessage(conversation) {
    return getMessages(conversation.id).slice(-1)[0] || null;
  }

  function conversationName(conversation) {
    if (conversation.type === 'group') return conversation.name;
    const other = getMembers(conversation).find(user => String(user.id) !== String(session.id));
    return other ? displayName(other) : 'Direct message';
  }

  function showFeedback(message) {
    const element = document.getElementById('messagesFeedback');
    element.textContent = message;
    element.hidden = false;
    clearTimeout(feedbackTimer);
    feedbackTimer = setTimeout(() => { element.hidden = true; }, 6000);
  }

  function formatTime(value) {
    if (!value) return '';
    return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(value));
  }

  function renderConversations() {
    const query = document.getElementById('peopleSearch').value.trim().toLowerCase();
    const conversations = readCollection(CONVERSATIONS_KEY)
      .filter(item => Array.isArray(item.member_ids) && item.member_ids.includes(String(session.id)))
      .sort((a, b) => new Date(latestMessage(b)?.created_at || b.created_at) - new Date(latestMessage(a)?.created_at || a.created_at))
      .filter(item => `${conversationName(item)} ${item.topic || ''}`.toLowerCase().includes(query));
    const container = document.getElementById('conversationList');
    if (!conversations.length) {
      container.innerHTML = `<p class="messages-list-empty">${query ? 'No matching conversations yet.' : 'No conversations yet. Search for someone to start a chat.'}</p>`;
      return;
    }
    container.innerHTML = conversations.map(conversation => {
      const title = conversationName(conversation);
      const last = latestMessage(conversation);
      const avatarText = conversation.type === 'group' ? initials(conversation.name) : initials(title);
      return `<button type="button" class="messages-list-item${conversation.id === selectedConversationId ? ' selected' : ''}" data-conversation-id="${escapeHtml(conversation.id)}">
        <span class="messages-avatar">${conversation.type === 'group' ? '<i class="fa-solid fa-user-group" aria-hidden="true"></i>' : escapeHtml(avatarText)}</span>
        <span class="messages-list-copy"><strong>${escapeHtml(title)}</strong><span>${escapeHtml(last ? `${last.sender_id === session.id ? 'You: ' : ''}${last.body}` : conversation.topic || 'Start a conversation')}</span></span>
      </button>`;
    }).join('');
    container.querySelectorAll('[data-conversation-id]').forEach(button => {
      button.addEventListener('click', () => openConversation(button.dataset.conversationId));
    });
  }

  function renderPeople() {
    const query = document.getElementById('peopleSearch').value.trim().toLowerCase();
    const container = document.getElementById('peopleList');
    const heading = document.getElementById('peopleListLabel');
    if (!query) {
      container.innerHTML = '';
      heading.hidden = true;
      return;
    }
    heading.hidden = false;
    const people = NexovantaDB.Users.getAll()
      .filter(user => user.auth_user_id)
      .filter(user => String(user.id) !== String(session.id))
      .filter(user => `${user.full_name || ''} ${user.username || ''} ${user.role || ''}`.toLowerCase().includes(query))
      .slice(0, 12);
    if (!people.length) {
      container.innerHTML = '<p class="messages-list-empty">No matching people found.</p>';
      return;
    }
    container.innerHTML = people.map(user => `<button type="button" class="messages-list-item" data-user-id="${escapeHtml(user.id)}">
      <span class="messages-avatar">${escapeHtml(initials(displayName(user)))}</span>
      <span class="messages-list-copy"><strong>${escapeHtml(displayName(user))}</strong><span>@${escapeHtml(user.username)} · ${escapeHtml(user.role || 'member')}</span></span>
    </button>`).join('');
    container.querySelectorAll('[data-user-id]').forEach(button => {
      button.addEventListener('click', () => {
        startDirectConversation(button.dataset.userId).catch(error => {
          console.error('Could not start direct conversation:', error);
          showFeedback('Could not start this conversation. Please try again.');
        });
      });
    });
  }

  function renderThread(conversation) {
    const thread = document.getElementById('messageThread');
    const messages = getMessages(conversation.id);
    if (!messages.length) {
      thread.innerHTML = '<p class="messages-thread-empty">This is the beginning of your conversation. Say hello!</p>';
      return;
    }
    thread.innerHTML = messages.map(message => {
      const author = NexovantaDB.Users.getById(message.sender_id);
      const mine = String(message.sender_id) === String(session.id);
      return `<article class="messages-bubble-row${mine ? ' mine' : ''}">
        ${conversation.type === 'group' && !mine ? `<span class="messages-sender">${escapeHtml(author ? displayName(author) : 'Community member')}</span>` : ''}
        <div class="messages-bubble">${escapeHtml(message.body)}</div>
        <time class="messages-time" datetime="${escapeHtml(message.created_at)}">${escapeHtml(formatTime(message.created_at))}</time>
      </article>`;
    }).join('');
    thread.scrollTop = thread.scrollHeight;
  }

  function openConversation(id) {
    const conversation = readCollection(CONVERSATIONS_KEY).find(item =>
      item.id === id && Array.isArray(item.member_ids) && item.member_ids.includes(String(session.id))
    );
    if (!conversation) {
      showFeedback('That conversation is not available to your account.');
      return;
    }
    selectedConversationId = conversation.id;
    shell.classList.add('chat-open');
    document.getElementById('emptyChat').hidden = true;
    document.getElementById('activeChat').hidden = false;
    const members = getMembers(conversation);
    const title = conversationName(conversation);
    document.getElementById('chatTitle').textContent = title;
    document.getElementById('chatSubtitle').textContent = conversation.type === 'group'
      ? `${members.length} members${conversation.topic ? ` · ${conversation.topic}` : ''}`
      : `@${(members.find(user => String(user.id) !== String(session.id)) || {}).username || ''}`;
    document.getElementById('chatAvatar').innerHTML = conversation.type === 'group'
      ? '<i class="fa-solid fa-user-group" aria-hidden="true"></i>'
      : escapeHtml(initials(title));
    renderThread(conversation);
    renderConversations();
    document.getElementById('messageInput').focus();
  }

  async function startDirectConversation(userId) {
    const person = NexovantaDB.Users.getById(userId);
    if (!person || !person.auth_user_id || String(person.id) === String(session.id)) return;
    const members = [String(session.id), String(person.id)].sort();
    let conversation = readCollection(CONVERSATIONS_KEY).find(item =>
      item.type === 'direct' &&
      Array.isArray(item.member_ids) &&
      item.member_ids.length === 2 &&
      members.every(id => item.member_ids.includes(id))
    );
    if (!conversation) {
      conversation = {
        id: NexovantaDB.uuid(),
        type: 'direct',
        name: '',
        topic: '',
        member_ids: members,
        created_by: String(session.id),
        created_at: new Date().toISOString(),
      };
      const conversations = readCollection(CONVERSATIONS_KEY);
      conversations.push(conversation);
      try {
        await saveCollection(CONVERSATIONS_KEY, conversations);
      } catch (error) {
        localStorage.setItem(CONVERSATIONS_KEY, JSON.stringify(conversations.filter(item => item.id !== conversation.id)));
        showFeedback(error.message || 'Could not start this conversation. Please try again.');
        return;
      }
    }
    document.getElementById('peopleSearch').value = '';
    renderPeople();
    openConversation(conversation.id);
  }

  function openGroupModal() {
    const members = NexovantaDB.Users.getAll()
      .filter(user => user.auth_user_id)
      .filter(user => String(user.id) !== String(session.id));
    const picker = document.getElementById('groupMembers');
    picker.innerHTML = members.length
      ? members.map(user => `<label class="messages-member-option"><input type="checkbox" value="${escapeHtml(user.id)}"><span>${escapeHtml(displayName(user))}<small>@${escapeHtml(user.username)} · ${escapeHtml(user.role || 'member')}</small></span></label>`).join('')
      : '<p class="messages-member-empty">No other members are available yet.</p>';
    document.getElementById('groupForm').reset();
    document.getElementById('groupError').hidden = true;
    document.getElementById('groupModal').hidden = false;
    document.getElementById('groupName').focus();
  }

  async function createGroup(event) {
    event.preventDefault();
    const name = document.getElementById('groupName').value.trim();
    const topic = document.getElementById('groupTopic').value.trim();
    const selectedIds = Array.from(document.querySelectorAll('#groupMembers input:checked')).map(input => input.value);
    const error = document.getElementById('groupError');
    if (!name) {
      error.textContent = 'Enter a name for your group.';
      error.hidden = false;
      return;
    }
    if (!selectedIds.length) {
      error.textContent = 'Choose at least one person to add to your group.';
      error.hidden = false;
      return;
    }
    const conversation = {
      id: NexovantaDB.uuid(),
      type: 'group',
      name,
      topic,
      member_ids: Array.from(new Set([String(session.id), ...selectedIds])).sort(),
      created_by: String(session.id),
      created_at: new Date().toISOString(),
    };
    const conversations = readCollection(CONVERSATIONS_KEY);
    conversations.push(conversation);
    const submitButton = event.currentTarget.querySelector('[type="submit"]');
    submitButton.disabled = true;
    try {
      await saveCollection(CONVERSATIONS_KEY, conversations);
    } catch (saveError) {
      localStorage.setItem(CONVERSATIONS_KEY, JSON.stringify(conversations.filter(item => item.id !== conversation.id)));
      error.textContent = saveError.message || 'Could not create the group. Please try again.';
      error.hidden = false;
      return;
    } finally {
      submitButton.disabled = false;
    }
    document.getElementById('groupModal').hidden = true;
    document.getElementById('peopleSearch').value = '';
    renderPeople();
    renderConversations();
    openConversation(conversation.id);
  }

  async function sendMessage(event) {
    event.preventDefault();
    const input = document.getElementById('messageInput');
    const body = input.value.trim();
    if (!body || !selectedConversationId) return;
    const conversation = readCollection(CONVERSATIONS_KEY).find(item =>
      item.id === selectedConversationId && item.member_ids.includes(String(session.id))
    );
    if (!conversation) {
      showFeedback('You are no longer a member of this conversation.');
      return;
    }
    const messages = readCollection(MESSAGES_KEY);
    const message = {
      id: NexovantaDB.uuid(),
      conversation_id: conversation.id,
      sender_id: String(session.id),
      body,
      created_at: new Date().toISOString(),
    };
    const nextMessages = [...messages, message];
    const sendButton = document.querySelector('#messageForm button[type="submit"]');
    sendButton.disabled = true;
    input.disabled = true;
    try {
      await saveCollection(MESSAGES_KEY, nextMessages);
    } catch (error) {
      localStorage.setItem(MESSAGES_KEY, JSON.stringify(messages));
      showFeedback(error.message || 'Message could not be sent. Please try again.');
      return;
    } finally {
      sendButton.disabled = false;
      input.disabled = false;
    }
    input.value = '';
    input.style.height = 'auto';
    renderThread(conversation);
    renderConversations();
  }

  async function refreshRemoteChats() {
    if (!NexovantaDB.supabase) return;
    const { data, error } = await NexovantaDB.supabase.from('nexovanta_records')
      .select('collection,record_id,data')
      .in('collection', [CONVERSATIONS_KEY, MESSAGES_KEY]);
    if (error) {
      console.error('Could not refresh messages:', error);
      showFeedback('Messages could not be refreshed. Check your connection and try again.');
      return;
    }
    const incoming = new Map([[CONVERSATIONS_KEY, []], [MESSAGES_KEY, []]]);
    (data || []).forEach(row => incoming.get(row.collection).push(row.data));
    [CONVERSATIONS_KEY, MESSAGES_KEY].forEach(key => {
      const merged = new Map(readCollection(key).map(record => [String(record.id), record]));
      incoming.get(key).forEach(record => merged.set(String(record.id), record));
      localStorage.setItem(key, JSON.stringify(Array.from(merged.values())));
    });
    renderConversations();
    renderPeople();
    if (selectedConversationId) {
      const conversation = readCollection(CONVERSATIONS_KEY).find(item => item.id === selectedConversationId);
      if (conversation) renderThread(conversation);
    }
  }

  async function initialize() {
    await NexovantaDB.ready;
    if (!session || !session.loggedIn) return;
    document.getElementById('peopleSearch').addEventListener('input', () => {
      renderConversations();
      renderPeople();
    });
    document.getElementById('messageForm').addEventListener('submit', event => {
      sendMessage(event).catch(error => {
        console.error('Could not send message:', error);
        showFeedback('Could not send your message. Please try again.');
      });
    });
    document.getElementById('newGroupButton').addEventListener('click', openGroupModal);
    document.getElementById('emptyGroupButton').addEventListener('click', openGroupModal);
    document.getElementById('closeGroupModal').addEventListener('click', () => {
      document.getElementById('groupModal').hidden = true;
    });
    document.getElementById('groupModal').addEventListener('click', event => {
      if (event.target.id === 'groupModal') event.currentTarget.hidden = true;
    });
    document.getElementById('groupForm').addEventListener('submit', event => {
      createGroup(event).catch(error => {
        console.error('Could not create group:', error);
        showFeedback('Could not create the group. Please try again.');
      });
    });
    document.getElementById('mobileBackButton').addEventListener('click', () => shell.classList.remove('chat-open'));
    document.getElementById('messageInput').addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        document.getElementById('messageForm').requestSubmit();
      }
    });
    document.getElementById('messageInput').addEventListener('input', event => {
      event.target.style.height = 'auto';
      event.target.style.height = `${Math.min(event.target.scrollHeight, 120)}px`;
    });
    renderConversations();
    renderPeople();
    await refreshRemoteChats();
    window.setInterval(refreshRemoteChats, 10000);
  }

  initialize().catch(error => {
    console.error('Could not initialize messages:', error);
    showFeedback('Messages could not be loaded. Refresh the page and try again.');
  });
})();
