import { createClient } from '@insforge/sdk';

const baseUrl = (import.meta.env.VITE_INSFORGE_BASE_URL || '').trim().replace(/\/$/, '');
const anonKey = (import.meta.env.VITE_INSFORGE_ANON_KEY || '').trim();

export function useInsforge() {
    return Boolean(baseUrl);
}

let _client = null;

export function getInsForgeClient() {
    if (!useInsforge()) return null;
    if (!_client) {
        _client = createClient({
            baseUrl,
            anonKey: anonKey || undefined,
            debug: import.meta.env.DEV && import.meta.env.VITE_INSFORGE_DEBUG === 'true'
        });
    }
    const http = _client.getHttpClient();
    const token = localStorage.getItem('chat_token');
    const refresh = localStorage.getItem('chat_refresh_token');
    http.setAuthToken(token || null);
    http.setRefreshToken(refresh || null);
    return _client;
}

export function resetInsForgeClient() {
    _client = null;
}

export function mapInsforgeUser(u) {
    if (!u) return null;
    const name = u.profile?.name || u.email?.split('@')[0] || 'User';
    return {
        id: u.id,
        username: name,
        email: u.email,
        avatar_url:
            u.profile?.avatar_url ||
            `https://ui-avatars.com/api/?name=${encodeURIComponent(name)}&background=random`
    };
}

export function persistInsforgeSession(session) {
    const { accessToken, refreshToken, user } = session;
    if (!accessToken || !user) return;
    const appUser = mapInsforgeUser(user);
    localStorage.setItem('chat_token', accessToken);
    localStorage.setItem('chat_user', JSON.stringify(appUser));
    if (refreshToken) localStorage.setItem('chat_refresh_token', refreshToken);
    else localStorage.removeItem('chat_refresh_token');
    localStorage.setItem('chat_backend', 'insforge');
    return appUser;
}

export async function hydrateInsforgeSession(client) {
    const token = localStorage.getItem('chat_token');
    if (!token) return false;
    try {
        client.getHttpClient().setAuthToken(token);
        client.getHttpClient().setRefreshToken(localStorage.getItem('chat_refresh_token'));
        const res = await client.getHttpClient().get('/api/auth/sessions/current');
        const u = res?.user;
        if (!u) return false;
        const appUser = mapInsforgeUser(u);
        localStorage.setItem('chat_user', JSON.stringify(appUser));
        return appUser;
    } catch {
        return false;
    }
}

/** After OAuth or sign-in, the SDK holds the user JWT in memory but not always in localStorage. */
export async function persistMemorySessionIfAny(client) {
    const { data, error } = await client.auth.getCurrentUser();
    if (error || !data?.user) return null;
    const headers = client.getHttpClient().getHeaders();
    const auth = headers.Authorization;
    if (!auth?.startsWith('Bearer ')) return null;
    const token = auth.slice('Bearer '.length);
    if (anonKey && token === anonKey) return null;
    return persistInsforgeSession({
        accessToken: token,
        refreshToken: localStorage.getItem('chat_refresh_token') || undefined,
        user: data.user
    });
}

export async function upsertProfileRow(client, appUser) {
    const row = {
        id: appUser.id,
        username: appUser.username,
        email: appUser.email,
        avatar_url: appUser.avatar_url
    };
    const { error } = await client.database.from('profiles').upsert(row, { onConflict: 'id' });
    if (error) throw new Error(error.message || 'Failed to save profile');
}

function normalizeMessageRow(row) {
    let profiles = row.profiles;
    if (Array.isArray(profiles)) profiles = profiles[0] || null;
    return {
        id: row.id,
        sender_id: row.sender_id,
        content: row.content,
        conversation_id: row.conversation_id,
        created_at: row.created_at,
        profiles: profiles || { username: 'Unknown', email: '' }
    };
}

export async function insforgeLoadMessages(client, conversationId) {
    let q = client.database
        .from('chat_messages')
        .select('id, sender_id, content, conversation_id, created_at, profiles(*)')
        .order('created_at', { ascending: true })
        .limit(300);
    if (conversationId) q = q.eq('conversation_id', conversationId);
    else q = q.is('conversation_id', null);
    const { data, error } = await q;
    if (error) throw new Error(error.message || 'Failed to load messages');
    return (data || []).map(normalizeMessageRow);
}

export async function insforgeInsertMessage(client, { sender_id, content, conversation_id }) {
    const { error } = await client.database.from('chat_messages').insert({
        sender_id,
        content,
        conversation_id: conversation_id || null
    });
    if (error) throw new Error(error.message || 'Failed to send message');
}

export async function insforgeSearchUsers(client, myId, query) {
    const esc = (s) => s.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
    const pattern = `%${esc(query)}%`;
    const { data: byName, error: e1 } = await client.database
        .from('profiles')
        .select('id, username, email, avatar_url')
        .ilike('username', pattern)
        .neq('id', myId)
        .limit(15);
    const { data: byEmail, error: e2 } = await client.database
        .from('profiles')
        .select('id, username, email, avatar_url')
        .ilike('email', pattern)
        .neq('id', myId)
        .limit(15);
    if (e1 || e2) throw new Error((e1 || e2).message || 'Search failed');
    const map = new Map();
    for (const r of [...(byName || []), ...(byEmail || [])]) map.set(r.id, r);
    return [...map.values()].slice(0, 15);
}

export async function insforgeGetOrCreateDm(client, myId, targetUserId) {
    const { data: mine, error: e1 } = await client.database
        .from('conversations')
        .select('*')
        .contains('participants', [myId]);
    if (e1) throw new Error(e1.message);
    const existing = (mine || []).find(
        (r) =>
            Array.isArray(r.participants) &&
            r.participants.length === 2 &&
            r.participants.includes(targetUserId)
    );
    if (existing) return await insforgeConvoWithProfiles(client, existing);
    const participants = [myId, targetUserId].sort();
    const { data: created, error: e2 } = await client.database
        .from('conversations')
        .insert({ participants })
        .select()
        .single();
    if (e2) throw new Error(e2.message || 'Could not open DM');
    return await insforgeConvoWithProfiles(client, created);
}

async function insforgeConvoWithProfiles(client, convo) {
    const { data: profs, error } = await client.database
        .from('profiles')
        .select('id, username, email, avatar_url')
        .in('id', convo.participants);
    if (error) throw new Error(error.message);
    return {
        ...convo,
        participantProfiles: profs || []
    };
}
