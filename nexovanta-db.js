/**
 * NexovantaDB — Centralised localStorage database layer
 * Chuka Community Platform — Social Network Data Management
 * 
 * All data is stored under namespaced keys in localStorage.
 * This module provides the CRUD helpers used across all pages.
 */

const NexovantaDB = (() => {

  // ─── Storage Keys ────────────────────────────────────────────────────────────
  const KEYS = {
    USERS:         'nx_users',
    POSTS:         'nx_posts',
    COMMENTS:      'nx_comments',
    REACTIONS:     'nx_reactions',
    EVENTS:        'nx_events',
    EVENT_RSVPS:   'nx_event_rsvps',
    SAVED_POSTS:   'nx_saved_posts',
    NOTIFICATIONS: 'nx_notifications',
    REPORTS:       'nx_reports',
    NEWS:          'nx_news',
    CHAT_CONVERSATIONS: 'nx_chat_conversations',
    CHAT_MESSAGES: 'nx_chat_messages',
    SESSION:       'nexovanta_user',
    SEEDED:        'nx_seeded_v5',
  };

  const RECORD_KEYS = [
    KEYS.POSTS, KEYS.COMMENTS, KEYS.REACTIONS, KEYS.EVENTS, KEYS.EVENT_RSVPS,
    KEYS.SAVED_POSTS, KEYS.NOTIFICATIONS, KEYS.REPORTS, KEYS.NEWS,
    KEYS.CHAT_CONVERSATIONS, KEYS.CHAT_MESSAGES,
    'nexovanta_shops_db', 'nexovanta_products_db', 'nexovanta_orders_db',
    'nexovanta_reviews_db', 'nexovanta_wishlist_db',
  ];
  const OWNER_FIELDS = {
    [KEYS.POSTS]: 'author_id',
    [KEYS.COMMENTS]: 'author_id',
    [KEYS.REACTIONS]: 'user_id',
    [KEYS.EVENTS]: 'organiser_id',
    [KEYS.EVENT_RSVPS]: 'user_id',
    [KEYS.SAVED_POSTS]: 'user_id',
    [KEYS.NOTIFICATIONS]: 'recipient_id',
    [KEYS.REPORTS]: 'reporter_id',
    [KEYS.NEWS]: 'author_id',
    [KEYS.CHAT_CONVERSATIONS]: 'created_by',
    [KEYS.CHAT_MESSAGES]: 'sender_id',
    nexovanta_shops_db: 'owner_id',
    nexovanta_reviews_db: 'author_id',
    nexovanta_wishlist_db: 'user_id',
  };
  const supabase = window.NexovantaSupabase || null;
  const remoteSnapshots = new Map();
  const pendingWrites = new Map();
  const LEGACY_BACKUP_KEY = 'nx_legacy_migration_backup_v1';
  const CLOUD_CACHE_KEY = 'nx_cloud_cache_v1';
  const CLOUD_CACHE_TTL = 60 * 1000;
  let activeAuthUserId = null;
  let activeProfileId = null;
  let cloudReady = false;
  let bannerShown = false;
  let profileWritePromise = Promise.resolve(true);

  function showDatabaseMessage(message) {
    console.error('Nexovanta database:', message);
    if (bannerShown || !document.body) return;
    bannerShown = true;
    const banner = document.createElement('div');
    banner.setAttribute('role', 'status');
    banner.style.cssText = 'position:fixed;z-index:99999;left:16px;right:16px;bottom:16px;padding:12px 16px;border-radius:10px;background:#7f1d1d;color:#fff;font:14px/1.45 system-ui,sans-serif;box-shadow:0 8px 30px #0008';
    banner.textContent = message;
    document.body.appendChild(banner);
  }

  function getRecordOwner(collection, record) {
    const ownerField = OWNER_FIELDS[collection];
    if (ownerField) return record[ownerField] || null;
    if (collection === 'nexovanta_products_db') {
      const shops = readAll('nexovanta_shops_db');
      const shop = shops.find(item => item.id === record.shop_id);
      return shop ? shop.owner_id || null : null;
    }
    return null;
  }

  function filterLocalRecords(collection, records) {
    if (!activeProfileId) return records;
    const session = Session.get();
    const isModerator = session && ['admin', 'moderator'].includes(session.account_role);
    if (collection === KEYS.NOTIFICATIONS) {
      return records.filter(record => record.recipient_id === activeProfileId);
    }
    if (collection === KEYS.REPORTS) {
      return records.filter(record => isModerator || record.reporter_id === activeProfileId);
    }
    if (collection === KEYS.SAVED_POSTS) {
      return records.filter(record => record.user_id === activeProfileId);
    }
    if (collection === 'nexovanta_orders_db') {
      const ownedShopIds = new Set(readAll('nexovanta_shops_db')
        .filter(shop => shop.owner_id === activeProfileId)
        .map(shop => shop.id));
      return records.filter(record => record.customer_id === activeProfileId || ownedShopIds.has(record.shop_id));
    }
    return records;
  }

  function recordCanBeWritten(collection, record) {
    const session = Session.get();
    if (session && ['admin', 'moderator'].includes(session.account_role)) return true;
    if (collection === 'nexovanta_orders_db') return true;
    if (collection === KEYS.NOTIFICATIONS) {
      return !!session && record.actor_username === session.username;
    }
    return !!activeProfileId && String(getRecordOwner(collection, record)) === String(activeProfileId);
  }

  function syncCollection(collection, records) {
    if (collection === 'nexovanta_wishlist_db') {
      const session = Session.get();
      if (!session) {
        localStorage.setItem(collection, JSON.stringify(records));
        return Promise.resolve();
      }
      const cacheKey = `${collection}_${session.id}`;
      const previous = readAll(cacheKey);
      localStorage.setItem(cacheKey, JSON.stringify(records));
      const toCloudRows = items => (items || []).map(productId => ({
        id: `${session.id}_${productId}`,
        product_id: productId,
        user_id: session.id,
      }));
      return queueCollectionWrite(collection, toCloudRows(records), toCloudRows(previous));
    }
    const previous = readAll(collection);
    localStorage.setItem(collection, JSON.stringify(records));
    return queueCollectionWrite(collection, records, previous);
  }

  function queueCollectionWrite(key, data, previousRecords) {
    if (!cloudReady || !supabase) return Promise.resolve(false);
    const previous = pendingWrites.get(key) || Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(() => persistCollection(key, data, previousRecords))
      .then(() => true)
      .catch(error => {
        showDatabaseMessage(`Could not save ${key} to Supabase: ${error.message || error}`);
        return false;
      });
    pendingWrites.set(key, next);
    return next;
  }

  async function persistCollection(collection, records, previousRecords) {
    const snapshot = remoteSnapshots.get(collection) || new Map();
    const current = new Map((records || []).filter(row => row && row.id).map(row => [String(row.id), row]));
    const previous = new Map((previousRecords || []).filter(row => row && row.id).map(row => [String(row.id), row]));
    const changed = [];
    current.forEach((record, recordId) => {
      const oldRecord = previous.get(recordId);
      if (oldRecord && JSON.stringify(oldRecord) === JSON.stringify(record)) return;
      if (!recordCanBeWritten(collection, record) &&
          !(Session.get() && ['admin', 'moderator'].includes(Session.get().account_role))) return;
      const prior = snapshot.get(recordId);
      if (prior && JSON.stringify(prior.data) === JSON.stringify(record)) return;
      changed.push({
        collection,
        record_id: recordId,
        owner_id: getRecordOwner(collection, record),
        data: record,
        updated_at: now(),
      });
    });

    if (changed.length) {
      const { error } = await supabase.from('nexovanta_records')
        .upsert(changed, { onConflict: 'collection,record_id' });
      if (error) throw error;
      changed.forEach(row => snapshot.set(row.record_id, { data: row.data, owner_id: row.owner_id }));
    }

    const removed = [];
    previous.forEach((oldRecord, recordId) => {
      if (!current.has(recordId) && recordCanBeWritten(collection, oldRecord)) removed.push(recordId);
    });
    if (removed.length) {
      const { error } = await supabase.from('nexovanta_records')
        .delete().eq('collection', collection).in('record_id', removed);
      if (error) throw error;
      removed.forEach(recordId => snapshot.delete(recordId));
    }
    remoteSnapshots.set(collection, snapshot);
  }

  function writeProfiles(profiles) {
    if (!cloudReady || !activeProfileId || !supabase) {
      profileWritePromise = Promise.resolve(false);
      return profileWritePromise;
    }
    const profile = profiles.find(item => item.id === activeProfileId);
    if (!profile) {
      profileWritePromise = Promise.resolve(false);
      return profileWritePromise;
    }
    const updates = {
      username: normalizeUsername(profile.username),
      full_name: profile.full_name || '',
      phone: profile.phone || '',
      avatar_url: profile.avatar_url || null,
      cover_photo_url: profile.cover_photo_url || null,
      bio: profile.bio || '',
      location: profile.location || '',
      community_category: profile.community_category || 'general',
      role: profile.role || 'student',
      privacy_settings: profile.privacy_settings || {},
      marketplace_shop_id: profile.marketplace_shop_id || null,
      updated_at: now(),
    };
    profileWritePromise = supabase.from('nexovanta_profiles')
      .update(updates)
      .eq('id', activeProfileId)
      .then(({ error }) => {
        if (error) {
          showDatabaseMessage(`Could not save your profile to Supabase: ${error.message}`);
          return false;
        }
        return true;
      })
      .catch(error => {
        showDatabaseMessage(`Could not save your profile to Supabase: ${error.message || error}`);
        return false;
      });
    return profileWritePromise;
  }

  async function fetchAllRows(table, columns) {
    const results = [];
    const pageSize = 1000;
    for (let offset = 0; ; offset += pageSize) {
      const { data, error } = await supabase.from(table)
        .select(columns)
        .range(offset, offset + pageSize - 1);
      if (error) throw error;
      results.push(...(data || []));
      if (!data || data.length < pageSize) return results;
    }
  }

  async function initializeCloud() {
    if (!supabase) {
      localStorage.removeItem(KEYS.SESSION);
      showDatabaseMessage('Supabase is not configured. Nexovanta is using local demo data; remote login and database persistence are unavailable. Set SUPABASE_URL and SUPABASE_ANON_KEY in your local .env file or hosting environment variables.');
      return false;
    }

    const { data: authData, error: authError } = await supabase.auth.getSession();
    if (authError) throw authError;
    activeAuthUserId = authData.session ? authData.session.user.id : null;
    if (!activeAuthUserId) localStorage.removeItem(KEYS.SESSION);

    const cacheUserId = activeAuthUserId || 'anonymous';
    let cachedCloudState = null;
    try {
      cachedCloudState = JSON.parse(localStorage.getItem(CLOUD_CACHE_KEY) || 'null');
    } catch (error) {
      console.error('Could not read the cloud cache timestamp:', error);
    }
    const cachedProfiles = readAll(KEYS.USERS);
    const hasCachedProfile = !activeAuthUserId ||
      cachedProfiles.some(profile => profile.auth_user_id === activeAuthUserId || profile.id === activeAuthUserId);
    if (hasCachedProfile && cachedCloudState &&
        cachedCloudState.userId === cacheUserId &&
        Date.now() - cachedCloudState.timestamp < CLOUD_CACHE_TTL) {
      const ownProfile = activeAuthUserId
        ? cachedProfiles.find(profile => profile.auth_user_id === activeAuthUserId || profile.id === activeAuthUserId)
        : null;
      activeProfileId = ownProfile ? ownProfile.id : null;
      if (ownProfile) Session.set(ownProfile);
      cloudReady = true;
      supabase.auth.onAuthStateChange((event, session) => {
        activeAuthUserId = session ? session.user.id : null;
        if (event === 'SIGNED_OUT') {
          activeProfileId = null;
          localStorage.removeItem(KEYS.SESSION);
          localStorage.removeItem(CLOUD_CACHE_KEY);
        }
      });
      return true;
    }

    backupLegacyCache();

    const profiles = await fetchAllRows('nexovanta_profiles_public', '*');

    if (activeAuthUserId) {
      const ownProfile = (profiles || []).find(item => item.auth_user_id === activeAuthUserId || item.id === activeAuthUserId);
      activeProfileId = ownProfile ? ownProfile.id : activeAuthUserId;
      const authUser = authData.session.user;
      const profileRows = readAll(KEYS.USERS);
      if (ownProfile) {
        const index = profileRows.findIndex(item => item.id === ownProfile.id);
        const hydrated = { ...ownProfile, email: authUser.email || '' };
        if (index === -1) profileRows.push(hydrated);
        else profileRows[index] = { ...profileRows[index], ...hydrated };
        localStorage.setItem(KEYS.USERS, JSON.stringify(profileRows));
        Session.set(hydrated);
      }
    }

    function backupLegacyCache() {
      if (localStorage.getItem(LEGACY_BACKUP_KEY)) return;
      const profiles = readAll(KEYS.USERS).map(profile => {
        const safeProfile = { ...profile };
        delete safeProfile.password_hash;
        delete safeProfile.password;
        return safeProfile;
      });
      const records = {};
      RECORD_KEYS.forEach(collection => { records[collection] = readAll(collection); });
      try {
        localStorage.setItem(LEGACY_BACKUP_KEY, JSON.stringify({ profiles, records }));
      } catch (error) {
        showDatabaseMessage(`Could not preserve a local migration copy: ${error.message || error}. Free browser storage before running the legacy-data migration.`);
      }
    }

    const remoteRows = await fetchAllRows('nexovanta_records', 'collection,record_id,owner_id,data');

    const grouped = new Map();
    (remoteRows || []).forEach(row => {
      if (!grouped.has(row.collection)) grouped.set(row.collection, []);
      grouped.get(row.collection).push(row);
    });
    RECORD_KEYS.forEach(collection => {
      const rows = grouped.get(collection) || [];
      const snapshot = new Map(rows.map(row => [String(row.record_id), {
        data: row.data,
        owner_id: row.owner_id,
      }]));
      remoteSnapshots.set(collection, snapshot);

      const local = filterLocalRecords(collection, readAll(collection));
      if (collection === 'nexovanta_wishlist_db') {
        const cacheKey = activeProfileId ? `${collection}_${activeProfileId}` : collection;
        const savedList = localStorage.getItem(cacheKey) === null ? readAll(collection) : readAll(cacheKey);
        const products = new Set(savedList);
        rows.forEach(row => products.add(row.data.product_id));
        localStorage.setItem(cacheKey, JSON.stringify(Array.from(products)));
        if (activeProfileId) localStorage.removeItem(collection);
        return;
      }
      const merged = new Map(local.filter(item => item && item.id).map(item => [String(item.id), item]));
      rows.forEach(row => merged.set(String(row.record_id), row.data));
      localStorage.setItem(collection, JSON.stringify(Array.from(merged.values())));
    });

    const authEmail = authData.session ? authData.session.user.email || '' : '';
    const localProfiles = readAll(KEYS.USERS).map(profile => ({
      ...profile,
      email: profile.id === activeProfileId ? authEmail : '',
    }));
    const mergedProfiles = new Map(localProfiles.map(item => [String(item.id), item]));
    (profiles || []).forEach(item => {
      const old = mergedProfiles.get(String(item.id)) || {};
      mergedProfiles.set(String(item.id), { ...old, ...item });
    });
    localStorage.setItem(KEYS.USERS, JSON.stringify(Array.from(mergedProfiles.values()).map(profile => ({
      ...profile,
      email: profile.id === activeProfileId ? authEmail : '',
      password_hash: undefined,
      password: undefined,
    }))));
    cloudReady = true;
    localStorage.setItem(CLOUD_CACHE_KEY, JSON.stringify({
      userId: cacheUserId,
      timestamp: Date.now(),
    }));
    supabase.auth.onAuthStateChange((event, session) => {
      activeAuthUserId = session ? session.user.id : null;
      if (event === 'SIGNED_OUT') {
        activeProfileId = null;
        localStorage.removeItem(KEYS.SESSION);
      }
    });
    return true;
  }

  const ready = new Promise(resolve => {
    document.addEventListener('DOMContentLoaded', () => {
      initializeCloud()
        .then(resolve)
        .catch(error => {
          showDatabaseMessage(`Supabase initialization failed: ${error.message || error}. Check the setup guide, project settings, and RLS policies.`);
          resolve(false);
        });
    }, { once: true });
  });

  // ─── Utility Helpers ─────────────────────────────────────────────────────────
  function uuid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }

  function now() { return new Date().toISOString(); }

  function minutesAgo(n) {
    return new Date(Date.now() - n * 60 * 1000).toISOString();
  }

  function hoursAgo(n) {
    return new Date(Date.now() - n * 3600 * 1000).toISOString();
  }

  function daysAgo(n) {
    return new Date(Date.now() - n * 86400 * 1000).toISOString();
  }

  function daysFromNow(n) {
    return new Date(Date.now() + n * 86400 * 1000).toISOString();
  }

  function readAll(key) {
    try {
      return JSON.parse(localStorage.getItem(key) || '[]');
    } catch { return []; }
  }

  function writeAll(key, data) {
    const previous = readAll(key);
    localStorage.setItem(key, JSON.stringify(data));
    if (key === KEYS.USERS) return writeProfiles(data);
    return queueCollectionWrite(key, data, previous);
  }

  function readObj(key) {
    try {
      return JSON.parse(localStorage.getItem(key) || '{}');
    } catch { return {}; }
  }

  // ─── Username Utilities ───────────────────────────────────────────────────────
  const USERNAME_REGEX = /^[a-zA-Z0-9_]{3,30}$/;

  function normalizeUsername(u) {
    return u.trim().toLowerCase().replace(/\s+/g, '');
  }

  function validateUsername(u) {
    const clean = normalizeUsername(u);
    if (!clean) return { valid: false, error: 'Username is required.' };
    if (clean.length < 3) return { valid: false, error: 'Username must be at least 3 characters.' };
    if (clean.length > 30) return { valid: false, error: 'Username must be 30 characters or fewer.' };
    if (!/^[a-z0-9_]+$/.test(clean)) return { valid: false, error: 'Only letters, numbers, and underscores are allowed.' };
    return { valid: true, username: clean };
  }

  function isUsernameTaken(username, excludeId = null) {
    const users = readAll(KEYS.USERS);
    const normalized = normalizeUsername(username);
    return users.some(u =>
      !!u.auth_user_id &&
      normalizeUsername(u.username) === normalized &&
      u.id !== excludeId
    );
  }

  // ─── Users / Profiles ─────────────────────────────────────────────────────────
  const Users = {
    getAll() { return readAll(KEYS.USERS); },

    getById(id) {
      return readAll(KEYS.USERS).find(u => u.id === id) || null;
    },

    getByUsername(username) {
      const norm = normalizeUsername(username);
      return readAll(KEYS.USERS).find(u => normalizeUsername(u.username) === norm) || null;
    },

    getByEmail(email) {
      const norm = (email || '').trim().toLowerCase();
      return readAll(KEYS.USERS).find(u => (u.email || '').toLowerCase() === norm) || null;
    },

    async create(data) {
      if (!supabase) throw new Error('Supabase is not configured. Add the project URL and anon key before creating an account.');
      const email = (data.email || '').trim().toLowerCase();
      if (!email || !email.includes('@')) throw new Error('A valid email address is required for Supabase Auth.');
      const { data: authData, error } = await supabase.auth.signUp({
        email,
        password: data.password,
        options: {
          emailRedirectTo: `${window.location.origin}/login.html?verified=1`,
          data: {
            username: normalizeUsername(data.username),
            full_name: data.full_name || '',
            phone: data.phone || '',
            role: data.role || 'student',
            community_category: data.community_category || 'general',
            bio: data.bio || '',
            location: data.location || '',
          },
        },
      });
      if (error) throw error;
      if (!authData.user) throw new Error('Supabase Auth did not return a user.');

      activeAuthUserId = authData.session ? authData.user.id : null;
      const { data: profile, error: profileError } = await supabase
        .from('nexovanta_profiles_public')
        .select('*')
        .eq('auth_user_id', authData.user.id)
        .maybeSingle();
      if (profileError) throw profileError;
      activeProfileId = authData.session && profile ? profile.id : null;
      const user = {
        ...(profile || {}),
        id: profile ? profile.id : authData.user.id,
        username: normalizeUsername(data.username),
        full_name: data.full_name || '',
        email,
        phone: data.phone || '',
        role: data.role || 'student',
        community_category: data.community_category || 'general',
        bio: data.bio || '',
        location: data.location || '',
        account_role: 'member',
      };
      const users = readAll(KEYS.USERS).filter(item => item.id !== user.id);
      users.push(user);
      localStorage.setItem(KEYS.USERS, JSON.stringify(users));
      if (authData.session) Session.set(user);
      return { user, needsEmailConfirmation: !authData.session };
    },

    update(id, changes) {
      const users = readAll(KEYS.USERS);
      const idx = users.findIndex(u => u.id === id);
      if (idx === -1) return null;
      const safeChanges = { ...changes };
      delete safeChanges.password;
      delete safeChanges.password_hash;
      delete safeChanges.account_role;
      delete safeChanges.auth_user_id;
      delete safeChanges.id;
      users[idx] = { ...users[idx], ...safeChanges, updated_at: now() };
      writeAll(KEYS.USERS, users);
      return users[idx];
    },

    async updateAndSave(id, changes) {
      const users = readAll(KEYS.USERS);
      const idx = users.findIndex(user => user.id === id);
      if (idx === -1) throw new Error('The profile could not be found.');
      const previous = users[idx];
      const safeChanges = { ...changes };
      delete safeChanges.password;
      delete safeChanges.password_hash;
      delete safeChanges.account_role;
      delete safeChanges.auth_user_id;
      delete safeChanges.id;
      users[idx] = { ...previous, ...safeChanges, updated_at: now() };
      localStorage.setItem(KEYS.USERS, JSON.stringify(users));
      if (!cloudReady) return users[idx];
      const saved = await writeProfiles(users);
      if (!saved) {
        users[idx] = previous;
        localStorage.setItem(KEYS.USERS, JSON.stringify(users));
        throw new Error('Supabase did not save the profile changes. Please try again.');
      }
      return users[idx];
    },

    async uploadProfileImage(profileId, imageType, file) {
      if (!cloudReady || !supabase) {
        throw new Error('Supabase is not configured. Profile image uploads are unavailable.');
      }
      if (!activeProfileId || String(profileId) !== String(activeProfileId)) {
        throw new Error('You can only upload images to your own profile.');
      }
      if (!['avatar', 'cover'].includes(imageType)) {
        throw new Error('Choose a valid profile image type.');
      }
      const allowedTypes = {
        'image/jpeg': 'jpg',
        'image/png': 'png',
        'image/webp': 'webp',
      };
      if (!file || !allowedTypes[file.type]) {
        throw new Error('Choose a JPG, PNG, or WebP image.');
      }
      if (file.size > 5 * 1024 * 1024) {
        throw new Error('Images must be 5 MB or smaller.');
      }
      const filePath = `${profileId}/${imageType}-${uuid()}.${allowedTypes[file.type]}`;
      const { error } = await supabase.storage
        .from('profile-media')
        .upload(filePath, file, {
          cacheControl: '3600',
          contentType: file.type,
          upsert: false,
        });
      if (error) throw new Error(`Image upload failed: ${error.message}`);
      const { data } = supabase.storage.from('profile-media').getPublicUrl(filePath);
      if (!data || !data.publicUrl) {
        throw new Error('The image uploaded, but Supabase did not return its public URL.');
      }
      return data.publicUrl;
    },

    async authenticate(identifier, password) {
      if (!supabase) return { success: false, error: 'Supabase is not configured. Remote login is unavailable.' };
      const email = (identifier || '').trim().toLowerCase();
      if (!email.includes('@')) return { success: false, error: 'Sign in using the email address on your account.' };
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) return { success: false, error: 'Invalid email or password.' };
      activeAuthUserId = data.user.id;

      const { data: profile, error: profileError } = await supabase
        .from('nexovanta_profiles_public')
        .select('*')
        .eq('auth_user_id', data.user.id)
        .maybeSingle();
      if (profileError || !profile) {
        await supabase.auth.signOut();
        activeAuthUserId = null;
        return {
          success: false,
          error: profileError ? profileError.message : 'Your account profile is missing. Contact the site administrator.',
        };
      }

      const user = { ...profile, email: data.user.email || '' };
      activeProfileId = profile.id;
      const users = readAll(KEYS.USERS).filter(item => item.id !== user.id);
      users.push(user);
      localStorage.setItem(KEYS.USERS, JSON.stringify(users));
      return { success: true, user };
    },

    async resetPassword(email) {
      if (!supabase) throw new Error('Supabase is not configured.');
      const cleanEmail = (email || '').trim().toLowerCase();
      if (!cleanEmail.includes('@')) throw new Error('Enter the email address on your account first.');
      const { error } = await supabase.auth.resetPasswordForEmail(cleanEmail, {
        redirectTo: `${window.location.origin}${window.location.pathname}?mode=recovery`,
      });
      if (error) throw error;
    },

    async updatePassword(password) {
      if (!supabase || !activeAuthUserId) throw new Error('Open the password reset link from your email first.');
      const { error } = await supabase.auth.updateUser({ password });
      if (error) throw error;
    },
  };

  // ─── Session ──────────────────────────────────────────────────────────────────
  const Session = {
    get() {
      try { return JSON.parse(localStorage.getItem(KEYS.SESSION) || 'null'); } catch { return null; }
    },
    set(user) {
      if (!user || !activeAuthUserId || String(user.id) !== String(activeProfileId)) {
        showDatabaseMessage('A valid Supabase Auth session is required. Demo/local profiles cannot create a signed-in session.');
        return null;
      }
      const session = {
        id: user.id,
        auth_user_id: activeAuthUserId,
        username: user.username,
        full_name: user.full_name,
        email: user.email,
        avatar_url: user.avatar_url,
        role: user.role,
        account_role: user.account_role || 'member',
        roleTitle: user.role === 'student' ? 'Chuka Student 🎓'
                  : user.role === 'business' ? 'Chuka Merchant 💼'
                  : 'Chuka Resident 🏘️',
        marketplace_shop_id: user.marketplace_shop_id || null,
        loggedIn: true,
      };
      localStorage.setItem(KEYS.SESSION, JSON.stringify(session));
      return session;
    },
    clear() {
      localStorage.removeItem(KEYS.SESSION);
      activeAuthUserId = null;
      activeProfileId = null;
      return supabase ? supabase.auth.signOut().then(({ error }) => {
        if (error) showDatabaseMessage(`Could not sign out from Supabase: ${error.message}`);
      }) : Promise.resolve();
    },
    isLoggedIn() { const s = Session.get(); return !!(s && s.loggedIn && s.id); },
    requireAuth() {
      if (!Session.isLoggedIn()) {
        window.location.href = 'login.html';
        return null;
      }
      return Session.get();
    },
  };

  // ─── Posts ────────────────────────────────────────────────────────────────────
  const Posts = {
    getAll() { return readAll(KEYS.POSTS).sort((a, b) => new Date(b.created_at) - new Date(a.created_at)); },

    getById(id) { return readAll(KEYS.POSTS).find(p => p.id === id) || null; },

    getByAuthor(username) {
      return readAll(KEYS.POSTS)
        .filter(p => p.author_username === normalizeUsername(username))
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    },

    getByCategory(category) {
      return readAll(KEYS.POSTS)
        .filter(p => p.category === category && p.status === 'published')
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    },

    create(data) {
      const posts = readAll(KEYS.POSTS);
      const post = {
        id: uuid(),
        author_username: normalizeUsername(data.author_username),
        author_id: data.author_id,
        content: data.content || '',
        post_type: data.post_type || 'text', // text | image | video | news | event
        category: data.category || 'general', // campus | community | business | news | event
        status: data.status || 'published',
        location: data.location || '',
        hashtags: data.hashtags || [],
        media: data.media || [], // [{type, url, thumbnail_url, name}]
        created_at: now(),
        updated_at: now(),
      };
      posts.unshift(post);
      writeAll(KEYS.POSTS, posts);
      // Notify followers (simplified — notify all users for demo)
      return post;
    },

    update(id, changes, requesterId) {
      const posts = readAll(KEYS.POSTS);
      const idx = posts.findIndex(p => p.id === id);
      if (idx === -1) return null;
      if (posts[idx].author_id !== requesterId) return { error: 'Unauthorized' };
      posts[idx] = { ...posts[idx], ...changes, updated_at: now() };
      writeAll(KEYS.POSTS, posts);
      return posts[idx];
    },

    delete(id, requesterId) {
      const posts = readAll(KEYS.POSTS);
      const post = posts.find(p => p.id === id);
      if (!post) return false;
      const session = Session.get();
      if (post.author_id !== requesterId && session?.account_role !== 'admin' && session?.account_role !== 'moderator') return false;
      writeAll(KEYS.POSTS, posts.filter(p => p.id !== id));
      return true;
    },

    paginate(allPosts, page = 1, perPage = 10) {
      const start = (page - 1) * perPage;
      return {
        data: allPosts.slice(start, start + perPage),
        hasMore: allPosts.length > start + perPage,
        total: allPosts.length,
      };
    },
  };

  // ─── Comments ─────────────────────────────────────────────────────────────────
  const Comments = {
    getByPost(postId) {
      return readAll(KEYS.COMMENTS)
        .filter(c => c.post_id === postId && !c.parent_comment_id)
        .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    },

    getReplies(commentId) {
      return readAll(KEYS.COMMENTS)
        .filter(c => c.parent_comment_id === commentId)
        .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    },

    create(data) {
      const comments = readAll(KEYS.COMMENTS);
      const comment = {
        id: uuid(),
        post_id: data.post_id,
        author_username: normalizeUsername(data.author_username),
        author_id: data.author_id,
        parent_comment_id: data.parent_comment_id || null,
        content: data.content,
        created_at: now(),
        updated_at: now(),
      };
      comments.push(comment);
      writeAll(KEYS.COMMENTS, comments);

      // Send notification to post author
      const post = Posts.getById(data.post_id);
      if (post && post.author_id !== data.author_id) {
        Notifications.create({
          recipient_id: post.author_id,
          actor_username: data.author_username,
          notification_type: 'comment',
          entity_id: data.post_id,
          message: `@${data.author_username} commented on your post.`,
        });
      }

      return comment;
    },

    countByPost(postId) {
      return readAll(KEYS.COMMENTS).filter(c => c.post_id === postId).length;
    },

    delete(id, requesterId) {
      const comments = readAll(KEYS.COMMENTS);
      const comment = comments.find(c => c.id === id);
      if (!comment) return false;
      const session = Session.get();
      if (comment.author_id !== requesterId && session?.account_role !== 'admin') return false;
      writeAll(KEYS.COMMENTS, comments.filter(c => c.id !== id));
      return true;
    },
  };

  // ─── Reactions ────────────────────────────────────────────────────────────────
  const Reactions = {
    get(postId, userId) {
      return readAll(KEYS.REACTIONS).find(r => r.post_id === postId && r.user_id === userId) || null;
    },

    countByPost(postId) {
      return readAll(KEYS.REACTIONS).filter(r => r.post_id === postId).length;
    },

    toggle(postId, userId, reactionType = 'like') {
      const reactions = readAll(KEYS.REACTIONS);
      const existing = reactions.find(r => r.post_id === postId && r.user_id === userId);
      if (existing) {
        writeAll(KEYS.REACTIONS, reactions.filter(r => !(r.post_id === postId && r.user_id === userId)));
        return { action: 'removed', count: reactions.filter(r => r.post_id === postId).length - 1 };
      } else {
        const reaction = { id: uuid(), post_id: postId, user_id: userId, reaction_type: reactionType, created_at: now() };
        reactions.push(reaction);
        writeAll(KEYS.REACTIONS, reactions);

        // Notify post author
        const post = Posts.getById(postId);
        const session = Session.get();
        if (post && post.author_id !== userId && session) {
          Notifications.create({
            recipient_id: post.author_id,
            actor_username: session.username,
            notification_type: 'reaction',
            entity_id: postId,
            message: `@${session.username} liked your post.`,
          });
        }

        return { action: 'added', count: reactions.filter(r => r.post_id === postId).length };
      }
    },

    hasReacted(postId, userId) {
      return readAll(KEYS.REACTIONS).some(r => r.post_id === postId && r.user_id === userId);
    },
  };

  // ─── Events ───────────────────────────────────────────────────────────────────
  const Events = {
    getAll() {
      return readAll(KEYS.EVENTS)
        .filter(e => e.status !== 'deleted')
        .sort((a, b) => new Date(a.start_at) - new Date(b.start_at));
    },

    getUpcoming() {
      return Events.getAll().filter(e => new Date(e.start_at) >= new Date() && e.status === 'published');
    },

    getById(id) { return readAll(KEYS.EVENTS).find(e => e.id === id) || null; },

    create(data) {
      const events = readAll(KEYS.EVENTS);
      const event = {
        id: uuid(),
        organiser_id: data.organiser_id,
        organiser_username: normalizeUsername(data.organiser_username),
        title: data.title,
        slug: data.title.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, ''),
        description: data.description || '',
        cover_image_url: data.cover_image_url || null,
        category: data.category || 'community', // campus | community | business | sports | culture
        venue: data.venue || '',
        location: data.location || '',
        start_at: data.start_at,
        end_at: data.end_at,
        timezone: 'Africa/Nairobi',
        is_free: data.is_free !== false,
        price: data.price || 0,
        registration_url: data.registration_url || '',
        contact: data.contact || '',
        status: data.status || 'published',
        created_at: now(),
        updated_at: now(),
      };
      events.push(event);
      writeAll(KEYS.EVENTS, events);
      return event;
    },

    update(id, changes, requesterId) {
      const events = readAll(KEYS.EVENTS);
      const idx = events.findIndex(e => e.id === id);
      if (idx === -1) return null;
      const session = Session.get();
      if (events[idx].organiser_id !== requesterId && session?.account_role !== 'admin' && session?.account_role !== 'moderator') return { error: 'Unauthorized' };
      events[idx] = { ...events[idx], ...changes, updated_at: now() };
      writeAll(KEYS.EVENTS, events);
      return events[idx];
    },

    delete(id, requesterId) {
      const events = readAll(KEYS.EVENTS);
      const idx = events.findIndex(e => e.id === id);
      if (idx === -1) return false;
      const session = Session.get();
      if (events[idx].organiser_id !== requesterId && session?.account_role !== 'admin' && session?.account_role !== 'moderator') return false;
      events[idx].status = 'deleted';
      events[idx].updated_at = now();
      writeAll(KEYS.EVENTS, events);
      return true;
    },

    formatDateNairobi(isoString) {
      try {
        return new Date(isoString).toLocaleString('en-KE', {
          timeZone: 'Africa/Nairobi',
          weekday: 'short',
          year: 'numeric',
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        });
      } catch {
        return new Date(isoString).toLocaleString();
      }
    },
  };

  // ─── Event RSVPs ──────────────────────────────────────────────────────────────
  const EventRSVPs = {
    get(eventId, userId) {
      return readAll(KEYS.EVENT_RSVPS).find(r => r.event_id === eventId && r.user_id === userId) || null;
    },

    countByEvent(eventId) {
      return readAll(KEYS.EVENT_RSVPS).filter(r => r.event_id === eventId && r.response === 'going').length;
    },

    upsert(eventId, userId, response) {
      const rsvps = readAll(KEYS.EVENT_RSVPS);
      const existing = rsvps.findIndex(r => r.event_id === eventId && r.user_id === userId);
      if (existing !== -1) {
        rsvps[existing] = { ...rsvps[existing], response, updated_at: now() };
      } else {
        rsvps.push({ id: uuid(), event_id: eventId, user_id: userId, response, created_at: now(), updated_at: now() });
      }
      writeAll(KEYS.EVENT_RSVPS, rsvps);

      // Notify event organiser
      const event = Events.getById(eventId);
      const session = Session.get();
      if (event && event.organiser_id !== userId && session) {
        Notifications.create({
          recipient_id: event.organiser_id,
          actor_username: session.username,
          notification_type: 'event_rsvp',
          entity_id: eventId,
          message: `@${session.username} is ${response} to your event "${event.title}".`,
        });
      }

      return rsvps.find(r => r.event_id === eventId && r.user_id === userId);
    },
  };

  // ─── Saved Posts ──────────────────────────────────────────────────────────────
  const SavedPosts = {
    isSaved(userId, postId) {
      return readAll(KEYS.SAVED_POSTS).some(s => s.user_id === userId && s.post_id === postId);
    },

    toggle(userId, postId) {
      const saved = readAll(KEYS.SAVED_POSTS);
      const idx = saved.findIndex(s => s.user_id === userId && s.post_id === postId);
      if (idx !== -1) {
        writeAll(KEYS.SAVED_POSTS, saved.filter((_, i) => i !== idx));
        return false;
      } else {
        saved.push({ user_id: userId, post_id: postId, created_at: now() });
        writeAll(KEYS.SAVED_POSTS, saved);
        return true;
      }
    },

    getByUser(userId) {
      const savedEntries = readAll(KEYS.SAVED_POSTS).filter(s => s.user_id === userId);
      return savedEntries.map(s => Posts.getById(s.post_id)).filter(Boolean);
    },
  };

  // ─── Notifications ────────────────────────────────────────────────────────────
  const Notifications = {
    getByUser(userId) {
      return readAll(KEYS.NOTIFICATIONS)
        .filter(n => n.recipient_id === userId)
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
        .slice(0, 50);
    },

    getUnreadCount(userId) {
      return readAll(KEYS.NOTIFICATIONS).filter(n => n.recipient_id === userId && !n.read_at).length;
    },

    create(data) {
      const notifs = readAll(KEYS.NOTIFICATIONS);
      // Deduplicate: same actor, type, entity within last 10 minutes
      const recent = notifs.find(n =>
        n.recipient_id === data.recipient_id &&
        n.actor_username === data.actor_username &&
        n.notification_type === data.notification_type &&
        n.entity_id === data.entity_id &&
        (Date.now() - new Date(n.created_at).getTime()) < 600000
      );
      if (recent) return recent;

      const notif = {
        id: uuid(),
        recipient_id: data.recipient_id,
        actor_username: data.actor_username,
        notification_type: data.notification_type,
        entity_id: data.entity_id,
        message: data.message,
        read_at: null,
        created_at: now(),
      };
      notifs.unshift(notif);
      // Keep max 100 notifications
      writeAll(KEYS.NOTIFICATIONS, notifs.slice(0, 100));
      return notif;
    },

    markAllRead(userId) {
      const notifs = readAll(KEYS.NOTIFICATIONS).map(n =>
        n.recipient_id === userId ? { ...n, read_at: now() } : n
      );
      writeAll(KEYS.NOTIFICATIONS, notifs);
    },
  };

  // ─── News ─────────────────────────────────────────────────────────────────────
  const News = {
    getAll(includeAll = false) {
      const articles = readAll(KEYS.NEWS);
      return (includeAll ? articles : articles.filter(a => a.status === 'published'))
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    },

    getById(id) { return readAll(KEYS.NEWS).find(a => a.id === id) || null; },

    create(data) {
      const articles = readAll(KEYS.NEWS);
      const article = {
        id: uuid(),
        author_username: normalizeUsername(data.author_username),
        author_id: data.author_id,
        headline: data.headline,
        body: data.body,
        cover_image_url: data.cover_image_url || null,
        category: data.category || 'community',
        source_url: data.source_url || '',
        status: data.status || 'pending', // pending | published | rejected
        moderation_note: '',
        reviewed_by: null,
        created_at: now(),
        updated_at: now(),
      };
      articles.unshift(article);
      writeAll(KEYS.NEWS, articles);
      return article;
    },

    moderate(id, status, moderatorUsername, note = '') {
      const articles = readAll(KEYS.NEWS);
      const idx = articles.findIndex(a => a.id === id);
      if (idx === -1) return null;
      articles[idx] = { ...articles[idx], status, moderation_note: note, reviewed_by: moderatorUsername, updated_at: now() };
      writeAll(KEYS.NEWS, articles);

      // Notify author
      const article = articles[idx];
      Notifications.create({
        recipient_id: article.author_id,
        actor_username: moderatorUsername,
        notification_type: 'news_moderation',
        entity_id: id,
        message: `Your news article "${article.headline}" has been ${status}.`,
      });

      return articles[idx];
    },
  };

  // ─── Reports ──────────────────────────────────────────────────────────────────
  const Reports = {
    getAll() { return readAll(KEYS.REPORTS).sort((a, b) => new Date(b.created_at) - new Date(a.created_at)); },

    getPending() { return Reports.getAll().filter(r => r.status === 'pending'); },

    create(data) {
      const reports = readAll(KEYS.REPORTS);
      const report = {
        id: uuid(),
        reporter_id: data.reporter_id,
        reporter_username: data.reporter_username,
        content_type: data.content_type, // post | comment | event | news | user
        content_id: data.content_id,
        reason: data.reason,
        details: data.details || '',
        status: 'pending',
        reviewed_by: null,
        resolution_note: '',
        created_at: now(),
      };
      reports.push(report);
      writeAll(KEYS.REPORTS, reports);
      return report;
    },

    resolve(id, status, moderatorUsername, note = '') {
      const reports = readAll(KEYS.REPORTS);
      const idx = reports.findIndex(r => r.id === id);
      if (idx === -1) return null;
      reports[idx] = { ...reports[idx], status, reviewed_by: moderatorUsername, resolution_note: note };
      writeAll(KEYS.REPORTS, reports);
      return reports[idx];
    },
  };

  // ─── Time Formatting ──────────────────────────────────────────────────────────
  function timeAgo(isoString) {
    const seconds = Math.floor((Date.now() - new Date(isoString).getTime()) / 1000);
    if (seconds < 60) return 'just now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
    return new Date(isoString).toLocaleDateString('en-KE', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  // ─── Avatar Helper ────────────────────────────────────────────────────────────
  function getAvatarHtml(username, avatarUrl, size = 40) {
    if (avatarUrl) {
      return `<img src="${avatarUrl}" alt="@${username}" style="width:${size}px;height:${size}px;border-radius:50%;object-fit:cover;">`;
    }
    const initials = username.slice(0, 2).toUpperCase();
    const colors = ['#00d2ff','#00f5a0','#f59e0b','#10b981','#8b5cf6','#ef4444','#3b82f6'];
    const color = colors[username.charCodeAt(0) % colors.length];
    return `<div class="nx-avatar-initials" style="width:${size}px;height:${size}px;background:${color};font-size:${size * 0.35}px;">${initials}</div>`;
  }

  // ─── Seed Data ────────────────────────────────────────────────────────────────
  function createSeedProfile(data) {
    const user = {
      id: uuid(),
      username: normalizeUsername(data.username),
      full_name: data.full_name || '',
      email: (data.email || '').toLowerCase(),
      phone: data.phone || '',
      avatar_url: null,
      cover_photo_url: null,
      bio: data.bio || '',
      location: data.location || '',
      community_category: data.community_category || 'general',
      role: data.role || 'student',
      account_role: data.account_role || 'member',
      privacy_settings: { public_posts: true, show_email: false },
      marketplace_shop_id: null,
      created_at: now(),
      updated_at: now(),
    };
    const users = readAll(KEYS.USERS);
    users.push(user);
    localStorage.setItem(KEYS.USERS, JSON.stringify(users));
    return user;
  }

  function seedData() {
    if (localStorage.getItem(KEYS.SEEDED)) return;

    // Demo users
    const u1 = createSeedProfile({ username: 'chukastudent24', full_name: 'Dennis Munene', email: 'dennis@chuka.ac.ke', phone: '0712345678', role: 'student', community_category: 'campus', bio: 'Computer Science Year 3 @ Chuka University. Tech enthusiast & campus content creator.', location: 'Ndagani, Chuka', account_role: 'member' });
    const u2 = createSeedProfile({ username: 'ndaganicafe', full_name: 'Ndagani Fresh Cafe & Bakes', email: 'cafe@ndagani.co.ke', phone: '0723456789', role: 'business', community_category: 'business', bio: 'Your favourite campus cafe ☕ Warm mandazis, samosas & fresh juice. 10% student discount daily!', location: 'Ndagani Stage, Chuka', account_role: 'member' });
    const u3 = createSeedProfile({ username: 'chukaresidents', full_name: 'Elder Peterson Kamau', email: 'peterson@chuka.com', phone: '0734567890', role: 'resident', community_category: 'community', bio: 'Proud Ndagani resident and community leader. Keeping Chuka connected.', location: 'Chuka Town, Tharaka Nithi', account_role: 'member' });
    const u4 = createSeedProfile({ username: 'amosletela', full_name: 'Amos Letela', email: 'amos@nexovanta.co.ke', phone: '0745678901', role: 'student', community_category: 'campus', bio: 'Frontend Developer & Chuka Uni ICT Student. Building digital Africa 🚀', location: 'Ndagani, Chuka', account_role: 'admin' });
    const u5 = createSeedProfile({ username: 'tenebo_ict', full_name: 'Tenebo Kariuki', email: 'tenebo@chuka.ac.ke', phone: '0756789012', role: 'student', community_category: 'campus', bio: 'ICT student, blogger, campus photographer 📸', location: 'Chuka University Campus', account_role: 'moderator' });
    const u6 = createSeedProfile({ username: 'sunrisehostels', full_name: 'Sunrise Executive Hostels', email: 'sunrise@ndagani.co.ke', phone: '0767890123', role: 'business', community_category: 'business', bio: 'Premium student accommodation in Ndagani. 24/7 borehole water, WiFi, security. Best value near Chuka University.', location: 'Ndagani, near Gate A', account_role: 'member' });

    // Posts
    const p1 = Posts.create({ author_username: u1.username, author_id: u1.id, content: 'The sunset view over Mount Kenya from the New Science Complex roof terrace this evening was absolutely unreal! Wishing everyone revising for end-of-semester exams all the best. You\'ve got this! 📚✨ #ChukaUni #CampusLife', post_type: 'text', category: 'campus', created_at: minutesAgo(15) });
    const p2 = Posts.create({ author_username: u2.username, author_id: u2.id, content: 'Fresh warm mandazis, samosas & blended passion juice ready for all-night study sessions! 🥟☕ 10% discount for Chuka Uni students with your student ID, valid until Friday. Come through Ndagani Stage — we\'re open until midnight! #NdaganiEats #ChukaFoodie', post_type: 'text', category: 'business', created_at: hoursAgo(1) });
    const p3 = Posts.create({ author_username: u3.username, author_id: u3.id, content: 'Great news for Ndagani residents — Kenya Power and the Tharaka Nithi county youth project have completed streetlight repairs from Gate A all the way down to Ndagani junction. No more walking home in the dark! Thank you to all who reported this issue. #NdaganiCommunity #ChukaResidents', post_type: 'text', category: 'community', created_at: hoursAgo(3) });
    const p4 = Posts.create({ author_username: u4.username, author_id: u4.id, content: 'Just launched the Nexovanta Community Platform! 🚀 Our goal is to connect Chuka University students, local businesses, and Ndagani residents in one unified digital ecosystem. Sign up today and be part of Kenya\'s strongest university-town platform. #Nexovanta #ChukaDigital #TechForAfrica', post_type: 'text', category: 'campus', created_at: hoursAgo(5) });
    const p5 = Posts.create({ author_username: u5.username, author_id: u5.id, content: 'Photography tip of the day: The golden hour light in Ndagani around 6:30 PM is absolutely magical. Grabbed these shots near the borehole area this evening 🌅 Which one is your favourite? #ChukaPhotography #NdaganiLife', post_type: 'text', category: 'community', created_at: hoursAgo(8) });
    const p6 = Posts.create({ author_username: u1.username, author_id: u1.id, content: 'Looking for a Python study group for the upcoming Data Structures & Algorithms exam! Any Year 3 CS students in Ndagani hostels interested? Drop a comment below. Let\'s ace this together 💪 #ChukaCS #StudyGroup', post_type: 'text', category: 'campus', created_at: daysAgo(1) });
    const p7 = Posts.create({ author_username: u6.username, author_id: u6.id, content: 'Rooms available at Sunrise Executive Hostels Ndagani! 🏠\n\n✅ Single rooms: KES 4,500/month\n✅ 24/7 borehole water supply\n✅ High-speed WiFi (50Mbps)\n✅ CCTV security, caretaker on-site\n✅ 5 mins walk from Chuka University Gate A\n\nContact us today to book a room! #NdaganiHostels #StudentAccommodation', post_type: 'text', category: 'community', created_at: daysAgo(2) });

    // Add some reactions
    Reactions.toggle(p1.id, u2.id);
    Reactions.toggle(p1.id, u3.id);
    Reactions.toggle(p1.id, u4.id);
    Reactions.toggle(p2.id, u1.id);
    Reactions.toggle(p2.id, u5.id);
    Reactions.toggle(p3.id, u1.id);
    Reactions.toggle(p3.id, u2.id);
    Reactions.toggle(p4.id, u1.id);
    Reactions.toggle(p4.id, u2.id);
    Reactions.toggle(p4.id, u3.id);
    Reactions.toggle(p4.id, u5.id);

    // Add some comments
    Comments.create({ post_id: p1.id, author_username: u3.username, author_id: u3.id, content: 'Beautiful view! Those mountain sunsets from the science block are legendary. Good luck to all students with exams! 🙏' });
    Comments.create({ post_id: p1.id, author_username: u5.username, author_id: u5.id, content: 'Totally agree! I took some photos up there last week. The view towards Tharaka is stunning at golden hour.' });
    Comments.create({ post_id: p2.id, author_username: u1.username, author_id: u1.id, content: 'Coming through tonight after my algorithms revision session! Keep the samosas warm 😄' });
    Comments.create({ post_id: p4.id, author_username: u1.username, author_id: u1.id, content: 'This is exactly what Chuka needed. The marketplace feature is amazing — already bought revision books through it!' });
    Comments.create({ post_id: p4.id, author_username: u2.username, author_id: u2.id, content: 'Already registered our cafe. Getting enquiries from students immediately. Nexovanta is a game changer for local business! 🙌' });

    // News articles
    News.create({ author_username: u5.username, author_id: u5.id, headline: 'Chuka University Academic Senate: Course Registration Deadline Extended', body: 'The Academic Senate of Chuka University has announced a 3-working-day extension to the course registration deadline for all continuing undergraduate faculties. Students are advised to complete their registration through the Student Portal before the new deadline. The extension applies to all faculties including Science & Technology, Business Studies, Health Sciences, Humanities, Law, and Agriculture. Contact your respective Faculty Office for guidance.', category: 'campus', status: 'published', created_at: minutesAgo(25) });
    News.create({ author_username: u3.username, author_id: u3.id, headline: 'Lost & Found: Chuka Uni Smart Card Found at Library Gate', body: 'A Chuka University Smart Card belonging to a student named Faith Muthoni was found at the Library Gate entrance this morning. The card has been deposited at the University Security Desk at Gate B. The owner is requested to collect it with valid identification. If unclaimed within 7 days, it will be handed to the Student Affairs Office.', category: 'campus', status: 'published', created_at: hoursAgo(1) });
    News.create({ author_username: u4.username, author_id: u4.id, headline: 'Ndagani Main Road Streetlights Fully Restored After 3-Month Outage', body: 'After three months of darkness on the Ndagani main road, Kenya Power and the Tharaka Nithi county government\'s youth infrastructure project have completed repairs and upgrades to the streetlighting network. The restored lights now cover the stretch from Chuka University Gate A all the way down to the Ndagani junction, significantly improving safety for students walking to and from campus after hours. Residents have praised the county government\'s swift action following community petitions.', category: 'community', status: 'published', created_at: hoursAgo(3) });
    News.create({ author_username: u1.username, author_id: u1.id, headline: 'Chuka University to Host Annual ICT Innovation Expo 2026', body: 'The Department of Computer Science at Chuka University will host the Annual ICT Innovation Expo on October 28, 2026 at the University Main Hall. Students, faculty, and industry partners are invited to showcase digital projects, startups, and technology innovations. Categories include Mobile Applications, Web Development, AI & Machine Learning, Cybersecurity, and Community Tech Solutions. Registration is free for Chuka University students and staff. External visitors are welcome.', category: 'campus', status: 'pending', created_at: daysAgo(1) });
    News.create({ author_username: u2.username, author_id: u2.id, headline: 'New Student Canteen Opens Near Engineering Block', body: 'A modern student canteen has opened near the Engineering Block, offering affordable meals, fresh juices, and a comfortable study-and-eat environment. The canteen operates Monday through Sunday from 6 AM to 10 PM. Special student combo meals are available for KES 150, including chapati, beans, and a drink. The canteen has been certified by the University Health Services department.', category: 'campus', status: 'published', created_at: daysAgo(2) });

    // Events
    Events.create({ organiser_id: u4.id, organiser_username: u4.username, title: 'Chuka University ICT Innovation Expo 2026', description: 'Annual showcase of student technology projects, startup demos, and digital innovation. Open to all students, faculty, and the wider Chuka community. Featuring competitions with cash prizes, industry mentors, and networking opportunities.', category: 'campus', venue: 'Chuka University Main Hall', location: 'Chuka University, Tharaka Nithi', start_at: daysFromNow(14), end_at: daysFromNow(14), is_free: true, contact: '0745678901', status: 'published' });
    Events.create({ organiser_id: u2.id, organiser_username: u2.username, title: 'Ndagani Night Market & Food Festival', description: 'Join us for a vibrant night market featuring local food vendors, entertainment, and community celebrations. Sample the best of Ndagani\'s culinary scene — from nyama choma to fresh tropical juices. Live music from local artists, traditional dance performances, and street food competition.', category: 'community', venue: 'Ndagani Open Ground', location: 'Ndagani, Chuka', start_at: daysFromNow(7), end_at: daysFromNow(7), is_free: true, contact: '0723456789', status: 'published' });
    Events.create({ organiser_id: u5.id, organiser_username: u5.username, title: 'Campus Photography Walk: Golden Hour Edition', description: 'Join Chuka\'s photography community for a guided golden-hour photography walk around the university grounds. All skill levels welcome — bring any camera or smartphone. We\'ll explore the best spots for landscape, portrait, and street photography. Prints from the walk will be exhibited in the Library gallery.', category: 'campus', venue: 'Chuka University Main Gate', location: 'Chuka University Campus', start_at: daysFromNow(3), end_at: daysFromNow(3), is_free: true, contact: '0756789012', status: 'published' });
    Events.create({ organiser_id: u3.id, organiser_username: u3.username, title: 'Tharaka Nithi Community Development Forum', description: 'An open forum for residents, landlords, local leaders, and students to discuss infrastructure, security, development priorities, and community building initiatives in Ndagani and surrounding areas. Presentations from county representatives and community leaders.', category: 'community', venue: 'Chuka Town Hall', location: 'Chuka Town, Tharaka Nithi', start_at: daysFromNow(21), end_at: daysFromNow(21), is_free: true, contact: '0734567890', status: 'published' });
    Events.create({ organiser_id: u1.id, organiser_username: u1.username, title: 'Data Structures & Algorithms Study Bootcamp', description: 'Intensive 3-day study bootcamp for Computer Science and Engineering students preparing for end-of-semester exams. Covers arrays, linked lists, trees, graphs, sorting algorithms, and dynamic programming. Small group sessions with peer tutoring, past paper practice, and Q&A with senior students.', category: 'campus', venue: 'ICT Lab 3, Chuka University', location: 'Chuka University, Science Block', start_at: daysFromNow(5), end_at: daysFromNow(7), is_free: true, contact: '0712345678', status: 'published' });
    
    // Reports
    Reports.create({
      reporter_id: u1.id,
      reporter_username: u1.username,
      content_type: 'post',
      content_id: p7.id,
      reason: 'Suspected spam / duplicate listing',
      details: 'Same hostel listing posted across multiple categories in Ndagani feed.',
    });
    Reports.create({
      reporter_id: u3.id,
      reporter_username: u3.username,
      content_type: 'comment',
      content_id: 'demo-comment-flagged',
      reason: 'Inappropriate language in public thread',
      details: 'Comment violates community safety guidelines regarding respectful campus dialogue.',
    });
    Reports.create({
      reporter_id: u5.id,
      reporter_username: u5.username,
      content_type: 'user',
      content_id: u6.id,
      reason: 'Unverified business claim',
      details: 'Hostel operator has not provided student safety compliance verification.',
    });

    localStorage.setItem(KEYS.SEEDED, '1');
    console.log('NexovantaDB: Seed data loaded successfully.');
  }

  async function migrateLocalData() {
    await ready;
    if (!supabase || !activeProfileId) throw new Error('Sign in to Supabase before migrating local data.');
    const backup = readObj(LEGACY_BACKUP_KEY);
    const profileMap = new Map((backup.profiles || []).map(profile => [String(profile.id), profile]));
    readAll(KEYS.USERS).forEach(profile => profileMap.set(String(profile.id), profile));
    const profiles = Array.from(profileMap.values()).map(profile => {
      const safeProfile = { ...profile };
      delete safeProfile.password_hash;
      delete safeProfile.password;
      return safeProfile;
    });
    const records = [];
    RECORD_KEYS.forEach(collection => {
      if (collection === 'nexovanta_wishlist_db') {
        const session = Session.get();
        if (session) {
          const cacheKey = `${collection}_${session.id}`;
          const wishlist = new Set([
            ...((backup.records && backup.records[collection]) || []),
            ...(localStorage.getItem(collection) === null ? [] : readAll(collection)),
            ...(localStorage.getItem(cacheKey) === null ? [] : readAll(cacheKey)),
          ]);
          wishlist.forEach(productId => records.push({
            collection,
            record_id: `${session.id}_${productId}`,
            owner_id: session.id,
            data: { id: `${session.id}_${productId}`, product_id: productId, user_id: session.id },
          }));
        }
        return;
      }
      const localMap = new Map();
      ((backup.records && backup.records[collection]) || []).forEach(record => {
        if (record && record.id) localMap.set(String(record.id), record);
      });
      readAll(collection).forEach(record => {
        if (record && record.id) localMap.set(String(record.id), record);
      });
      localMap.forEach(record => {
        if (!record || !record.id) return;
        const safeRecord = { ...record };
        delete safeRecord.password_hash;
        delete safeRecord.password;
        records.push({
          collection,
          record_id: String(record.id),
          owner_id: getRecordOwner(collection, record),
          data: safeRecord,
        });
      });
    });
    const { data, error } = await supabase.rpc('nexovanta_migrate_legacy_data', {
      legacy_profiles: profiles,
      legacy_records: records,
    });
    if (error) throw error;
    await initializeCloud();
    return data;
  }

  // ─── Public API ───────────────────────────────────────────────────────────────
  return {
    Users,
    Session,
    Posts,
    Comments,
    Reactions,
    Events,
    EventRSVPs,
    SavedPosts,
    Notifications,
    News,
    Reports,
    seed: seedData,
    timeAgo,
    getAvatarHtml,
    validateUsername,
    isUsernameTaken,
    normalizeUsername,
    uuid,
    ready,
    migrateLocalData,
    syncCollection,
    supabase,
  };
})();

// Auto-seed on load
NexovantaDB.seed();
const cachedUsers = (() => {
  try { return JSON.parse(localStorage.getItem('nx_users') || '[]'); } catch { return []; }
})();
if (cachedUsers.some(user => Object.prototype.hasOwnProperty.call(user, 'password_hash'))) {
  cachedUsers.forEach(user => {
    delete user.password_hash;
    delete user.password;
  });
  localStorage.setItem('nx_users', JSON.stringify(cachedUsers));
}
