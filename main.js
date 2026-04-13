import { io } from 'socket.io-client';
import {
    useInsforge,
    getInsForgeClient,
    resetInsForgeClient,
    persistInsforgeSession,
    hydrateInsforgeSession,
    persistMemorySessionIfAny,
    upsertProfileRow,
    insforgeLoadMessages,
    insforgeInsertMessage,
    insforgeSearchUsers,
    insforgeGetOrCreateDm
} from './insforge.js';

const THEME_KEY = 'vibely_theme';
const BACKEND_KEY = 'chat_backend';
const LAST_EMAIL_KEY = 'vibely_last_email';
const EMOJI_PRESET =
    '😀😃😄😁😅🤣😂🙂😉😊😍🥰😘😗😜🤗🤔😎🤩🥳😇🙃😴🤯😮‍💨🙏👍👎👋✌️🤞💪🔥💯❤️✨⭐🎉🎊👀🙈💬💤';

/** Use InsForge only when configured *and* this browser session is tied to InsForge (or new visitor with no local token). */
function getInitialSyncMode() {
    const backend = localStorage.getItem(BACKEND_KEY);
    const hasToken = Boolean(localStorage.getItem('chat_token'));
    if (backend === 'insforge') {
        return useInsforge() ? 'insforge' : 'local';
    }
    if (backend === 'local' || (hasToken && backend !== 'insforge')) {
        return 'local';
    }
    if (useInsforge()) return 'insforge';
    return 'local';
}

function normalizeBaseUrl(value) {
    return String(value).trim().replace(/\/$/, '');
}

function isStaticHostingOrigin() {
    const { protocol, hostname, port } = window.location;
    return (
        protocol === 'https:' &&
        port === '' &&
        (hostname.endsWith('.edgeone.app') ||
            hostname.endsWith('.pages.dev') ||
            hostname.endsWith('.netlify.app') ||
            hostname.endsWith('.vercel.app'))
    );
}

// Configuration — dev uses Vite proxy (same origin); production needs explicit API host on static/CDN deploys.
function getApiBase() {
    const explicit = import.meta.env.VITE_API_BASE_URL;
    if (explicit != null && String(explicit).trim() !== '') {
        return normalizeBaseUrl(explicit);
    }
    if (import.meta.env.DEV) return '';
    const p = window.location.port;
    if (p === '4173' || p === '5173') {
        return `${window.location.protocol}//${window.location.hostname}:3000`;
    }
    if (isStaticHostingOrigin()) {
        return null;
    }
    return '';
}

function getSocketUrl() {
    const explicit = import.meta.env.VITE_SOCKET_URL;
    if (explicit != null && String(explicit).trim() !== '') {
        return normalizeBaseUrl(explicit);
    }
    if (import.meta.env.DEV) return window.location.origin;
    const p = window.location.port;
    if (p === '4173' || p === '5173') {
        return `${window.location.protocol}//${window.location.hostname}:3000`;
    }
    if (isStaticHostingOrigin()) {
        return null;
    }
    return window.location.origin;
}

const API_URL = getApiBase();
const SOCKET_URL = getSocketUrl();
const STATIC_API_CONFIG_ERROR =
    'This deployment is missing VITE_API_BASE_URL / VITE_SOCKET_URL, so the app cannot reach the backend. Set those build-time env vars and redeploy.';
let socket;
let insforgePublicAuthConfig = null;

/** Treat missing / empty / null as global chat (must match server + socket payloads). */
function normalizeConversationId(id) {
    if (id == null || id === '') return null;
    return String(id);
}
let messagePollTimer = null;

// State management
const state = {
    user: null,
    token: localStorage.getItem('chat_token'),
    messages: [],
    searchResults: [],
    typingTimeout: null,
    activeConversation: null,
    /** @type {'local' | 'insforge'} */
    syncMode: getInitialSyncMode(),
    pendingVerifyEmail: sessionStorage.getItem('pending_verify_email') || '',
    forceScrollOnNextRender: false,
    chatFeaturesWired: false,
    soundEnabled: localStorage.getItem('sound_enabled') !== 'false',
    onlineUsers: new Set(),
    editingMessage: null,
    messageStatuses: new Map(),
    userStatuses: new Map()
};

// DOM Elements
const elements = {
    authContainer: document.getElementById('auth-container'),
    chatContainer: document.getElementById('chat-container'),
    loginForm: document.getElementById('login-form'),
    signupForm: document.getElementById('signup-form'),
    verifyForm: document.getElementById('verify-form'),
    showSignup: document.getElementById('show-signup'),
    showLogin: document.getElementById('show-login'),
    loginEmail: document.getElementById('login-email'),
    loginPass: document.getElementById('login-password'),
    signupUser: document.getElementById('signup-username'),
    signupEmail: document.getElementById('signup-email'),
    signupPass: document.getElementById('signup-password'),
    verifyCode: document.getElementById('verify-code'),
    btnLogin: document.getElementById('btn-login'),
    btnSignup: document.getElementById('btn-signup'),
    btnVerify: document.getElementById('btn-verify'),
    btnGoogle: document.getElementById('btn-google'),
    btnGithub: document.getElementById('btn-github'),
    resendCode: document.getElementById('resend-code'),
    btnLogout: document.getElementById('btn-logout'),
    messagesArea: document.getElementById('messages-area'),
    messageInput: document.getElementById('message-input'),
    btnSend: document.getElementById('btn-send'),
    myUsername: document.getElementById('my-username'),
    adminLink: document.getElementById('admin-link'),
    myAvatar: document.getElementById('my-avatar'),
    toastContainer: document.getElementById('toast-container'),
    chatList: document.getElementById('chat-list'),
    searchInput: document.getElementById('user-search-input'),
    searchInputWrapper: document.getElementById('search-input-wrapper'),
    searchDropdown: document.getElementById('search-dropdown'),
    searchLoading: document.getElementById('search-loading'),
    searchEmpty: document.getElementById('search-empty'),
    searchResultsList: document.getElementById('search-results-list'),
    searchClearBtn: document.getElementById('search-clear-btn'),
    typingIndicator: null,
    btnTheme: document.getElementById('btn-theme'),
    btnThemeIcon: document.getElementById('btn-theme-icon'),
    btnScrollBottom: document.getElementById('btn-scroll-bottom'),
    btnEmoji: document.getElementById('btn-emoji'),
    btnAttach: document.getElementById('btn-attach'),
    imageInput: document.getElementById('image-input'),
    emojiPopover: document.getElementById('emoji-popover'),
    btnSound: document.getElementById('btn-sound'),
    btnGroup: document.getElementById('btn-group'),
    groupModal: document.getElementById('group-modal'),
    groupNameInput: document.getElementById('group-name'),
    groupParticipants: document.getElementById('group-participants'),
    editMessageContainer: document.getElementById('edit-message-container'),
    editMessageInput: document.getElementById('edit-message-input'),
    saveEditBtn: document.getElementById('save-edit-btn'),
    cancelEditBtn: document.getElementById('cancel-edit-btn')
};

function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    elements.toastContainer.appendChild(toast);
    setTimeout(() => {
        toast.style.opacity = '0';
        setTimeout(() => toast.remove(), 500);
    }, 3000);
}

function showAuthForm(form) {
    elements.loginForm.classList.toggle('hidden', form !== 'login');
    elements.signupForm.classList.toggle('hidden', form !== 'signup');
    elements.verifyForm.classList.toggle('hidden', form !== 'verify');
}

// --- LOCAL API ---
async function api(path, method = 'GET', body = null) {
    const headers = {
        'Content-Type': 'application/json'
    };

    if (state.token) {
        headers['Authorization'] = `Bearer ${state.token}`;
    }

    if (!API_URL && isStaticHostingOrigin() && state.syncMode !== 'insforge') {
        const err = new Error(STATIC_API_CONFIG_ERROR);
        showToast(err.message, 'error');
        throw err;
    }

    const url = API_URL ? `${API_URL}${path}` : path;
    try {
        const res = await fetch(url, {
            method,
            headers,
            body: body ? JSON.stringify(body) : null
        });

        let data = null;
        const contentType = res.headers.get('content-type');
        if (contentType && contentType.includes('application/json')) {
            data = await res.json();
        } else {
            const text = await res.text();
            try {
                data = JSON.parse(text);
            } catch {
                data = { message: text.slice(0, 200) || 'Invalid response' };
            }
        }

        if (!res.ok) {
            const validationMessage = Array.isArray(data?.errors) && data.errors.length > 0
                ? data.errors.map((entry) => entry.msg).filter(Boolean).join(', ')
                : '';
            throw new Error(validationMessage || data?.message || `Request failed (${res.status})`);
        }
        return data;
    } catch (err) {
        if (err instanceof TypeError && err.message.includes('fetch')) {
            showToast('Cannot reach server. Is it running on port 3000?', 'error');
        } else {
            showToast(err.message, 'error');
        }
        throw err;
    }
}

async function loadInsforgePublicAuthConfig() {
    if (state.syncMode !== 'insforge') return null;
    try {
        const client = getInsForgeClient();
        const { data, error } = await client.auth.getPublicAuthConfig();
        if (error) {
            console.warn('Failed to load InsForge public auth config:', error.message);
            return null;
        }
        insforgePublicAuthConfig = data || null;
        return insforgePublicAuthConfig;
    } catch (err) {
        console.warn('Failed to load InsForge public auth config:', err);
        return null;
    }
}

function getInsforgeRedirectTarget() {
    return `${window.location.origin}${window.location.pathname}`;
}

function isInsforgeCodeVerificationMode() {
    return insforgePublicAuthConfig?.verifyEmailMethod === 'code';
}

function handleInsforgeAuthRedirectMessage() {
    const params = new URLSearchParams(window.location.search);
    const status = params.get('insforge_status');
    const type = params.get('insforge_type');
    const error = params.get('insforge_error');

    if (!status || !type) return;

    if (type === 'verify_email') {
        if (status === 'success') {
            showToast('Email verified. You can now log in.', 'info');
            showAuthForm('login');
        } else {
            showToast(error || 'Email verification failed.', 'error');
        }
    }

    if (type === 'reset_password') {
        if (status === 'ready') {
            showToast('Password reset link accepted. Reset UI is not yet implemented in this app.', 'info');
        } else {
            showToast(error || 'Password reset link failed.', 'error');
        }
    }

    const nextUrl = new URL(window.location.href);
    nextUrl.searchParams.delete('insforge_status');
    nextUrl.searchParams.delete('insforge_type');
    nextUrl.searchParams.delete('insforge_error');
    nextUrl.searchParams.delete('token');
    window.history.replaceState({}, '', nextUrl.toString());
}

async function completeLocalLogin(email, password) {
    const data = await api('/login', 'POST', { email, password });
    state.user = data.user;
    state.token = data.token;
    localStorage.setItem('chat_token', data.token);
    localStorage.setItem('chat_user', JSON.stringify(data.user));
    localStorage.removeItem('chat_refresh_token');
    localStorage.setItem(BACKEND_KEY, 'local');
    localStorage.setItem(LAST_EMAIL_KEY, email);
    showToast('Logged in successfully!');
    setupApp();
}

async function handleLogin() {
    const email = elements.loginEmail.value.trim().toLowerCase();
    const password = elements.loginPass.value;

    if (!email || !password) return showToast('Please fill all fields', 'error');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return showToast('Enter a valid email address', 'error');

    elements.btnLogin.disabled = true;
    elements.btnLogin.textContent = 'Logging in...';

    try {
        if (state.syncMode === 'insforge') {
            const client = getInsForgeClient();
            const { data, error } = await client.auth.signInWithPassword({ email, password });
            if (error) {
                if (/verify|verification|email verified|confirm/i.test(error.message || '')) {
                    sessionStorage.setItem('pending_verify_email', email);
                    state.pendingVerifyEmail = email;
                    if (isInsforgeCodeVerificationMode()) {
                        showAuthForm('verify');
                    }
                    showToast(error.message, 'error');
                    return;
                }

                if (/invalid credentials|invalid login|wrong password|user not found|email or password/i.test(error.message || '')) {
                    await completeLocalLogin(email, password);
                    return;
                }

                showToast(error.message, 'error');
                return;
            }
            const appUser = persistInsforgeSession({
                accessToken: data.accessToken,
                refreshToken: data.refreshToken,
                user: data.user
            });
            state.user = appUser;
            state.token = data.accessToken;
            getInsForgeClient().getHttpClient().setAuthToken(data.accessToken);
            if (data.refreshToken) getInsForgeClient().getHttpClient().setRefreshToken(data.refreshToken);
            await upsertProfileRow(client, appUser);
            localStorage.setItem(LAST_EMAIL_KEY, email);
            showToast('Logged in successfully!');
            setupApp();
        } else {
            await completeLocalLogin(email, password);
        }
    } catch (err) {
        console.error(err);
    } finally {
        elements.btnLogin.disabled = false;
        elements.btnLogin.textContent = 'Login';
    }
}

async function handleSignup() {
    const username = elements.signupUser.value.trim();
    const email = elements.signupEmail.value.trim().toLowerCase();
    const password = elements.signupPass.value;

    if (!username || !email || !password) return showToast('Please fill all fields', 'error');
    if (username.length < 3) return showToast('Username must be at least 3 characters', 'error');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return showToast('Enter a valid email address', 'error');
    if (password.length < 8) return showToast('Password must be at least 8 characters', 'error');

    elements.btnSignup.disabled = true;
    elements.btnSignup.textContent = 'Creating account...';

    try {
        if (state.syncMode === 'insforge') {
            const client = getInsForgeClient();
            const { data, error } = await client.auth.signUp({
                email,
                password,
                name: username,
                redirectTo: getInsforgeRedirectTarget()
            });
            if (error) {
                showToast(error.message, 'error');
                return;
            }
            if (data?.requireEmailVerification) {
                sessionStorage.setItem('pending_verify_email', email);
                state.pendingVerifyEmail = email;
                if (isInsforgeCodeVerificationMode()) {
                    showAuthForm('verify');
                    showToast('Check your email for a verification code.', 'info');
                } else {
                    showAuthForm('login');
                    showToast('Check your email for a verification link, then come back and log in.', 'info');
                }
                return;
            }
            if (data?.accessToken && data?.user) {
                const appUser = persistInsforgeSession({
                    accessToken: data.accessToken,
                    refreshToken: data.refreshToken,
                    user: data.user
                });
                state.user = appUser;
                state.token = data.accessToken;
                await upsertProfileRow(client, appUser);
                localStorage.setItem(LAST_EMAIL_KEY, email);
                showToast('Account created!');
                setupApp();
            } else {
                showToast('Sign up incomplete — try logging in.', 'error');
            }
        } else {
            const data = await api('/register', 'POST', { username, email, password });
            state.user = data.user;
            state.token = data.token;
            localStorage.setItem('chat_token', data.token);
            localStorage.setItem('chat_user', JSON.stringify(data.user));
            localStorage.setItem(BACKEND_KEY, 'local');
            localStorage.setItem(LAST_EMAIL_KEY, email);
            showToast('Account created!');
            setupApp();
        }
    } catch (err) {
        console.error(err);
    } finally {
        elements.btnSignup.disabled = false;
        elements.btnSignup.textContent = 'Sign Up';
    }
}

async function handleVerifyEmail() {
    const email = (state.pendingVerifyEmail || sessionStorage.getItem('pending_verify_email') || '').trim();
    const otp = elements.verifyCode.value.trim();
    if (!email || !otp) return showToast('Enter the code from your email.', 'error');

    elements.btnVerify.disabled = true;
    elements.btnVerify.textContent = 'Verifying...';
    try {
        const client = getInsForgeClient();
        const { data, error } = await client.auth.verifyEmail({ email, otp });
        if (error) {
            showToast(error.message, 'error');
            return;
        }
        if (data?.accessToken && data?.user) {
            const appUser = persistInsforgeSession({
                accessToken: data.accessToken,
                refreshToken: data.refreshToken,
                user: data.user
            });
            state.user = appUser;
            state.token = data.accessToken;
            sessionStorage.removeItem('pending_verify_email');
            state.pendingVerifyEmail = '';
            await upsertProfileRow(client, appUser);
            elements.verifyCode.value = '';
            showAuthForm('login');
            showToast('Email verified. You are signed in!');
            setupApp();
        }
    } catch (e) {
        console.error(e);
    } finally {
        elements.btnVerify.disabled = false;
        elements.btnVerify.textContent = 'Verify Code';
    }
}

async function handleResendVerification() {
    const email = (state.pendingVerifyEmail || sessionStorage.getItem('pending_verify_email') || '').trim();
    if (!email) return showToast('No email to resend to.', 'error');
    try {
        const client = getInsForgeClient();
        const { error } = await client.auth.resendVerificationEmail({
            email,
            redirectTo: getInsforgeRedirectTarget()
        });
        if (error) showToast(error.message, 'error');
        else showToast('Verification email sent.', 'info');
    } catch (err) {
        showToast(err?.message || 'Failed to resend verification email.', 'error');
    }
}

async function handleOAuth(provider) {
    if (state.syncMode !== 'insforge') {
        showToast('OAuth uses InsForge. Set VITE_INSFORGE_BASE_URL in .env and restart Vite.', 'error');
        return;
    }
    const client = getInsForgeClient();
    const redirectTo = `${window.location.origin}${window.location.pathname}`;
    const { data, error } = await client.auth.signInWithOAuth({
        provider,
        redirectTo,
        skipBrowserRedirect: false
    });
    if (error) {
        showToast(error.message, 'error');
        return;
    }
    if (data?.url) window.location.href = data.url;
}

async function handleLogout() {
    if (socket) {
        socket.removeAllListeners();
        socket.disconnect();
        socket = null;
    }
    if (messagePollTimer) {
        clearInterval(messagePollTimer);
        messagePollTimer = null;
    }
    const savedTheme = localStorage.getItem(THEME_KEY);
    const savedEmail = localStorage.getItem(LAST_EMAIL_KEY);
    if (state.syncMode === 'insforge') {
        try {
            await getInsForgeClient()?.auth.signOut();
        } catch (_) {
            /* ignore */
        }
        resetInsForgeClient();
    }
    localStorage.clear();
    if (savedTheme) localStorage.setItem(THEME_KEY, savedTheme);
    if (savedEmail) localStorage.setItem(LAST_EMAIL_KEY, savedEmail);
    sessionStorage.removeItem('pending_verify_email');
    location.reload();
}

// --- CHAT LOGIC ---

async function loadMessages() {
    try {
        if (state.syncMode === 'insforge') {
            const client = getInsForgeClient();
            const convId = state.activeConversation?.id || null;
            const rows = await insforgeLoadMessages(client, convId);
            state.messages = Array.isArray(rows) ? rows : [];
        } else {
            const path = state.activeConversation?.id
                ? `/messages?conversation_id=${encodeURIComponent(state.activeConversation.id)}`
                : '/messages';
            const data = await api(path);
            state.messages = Array.isArray(data) ? data : [];
        }
        renderMessages();
    } catch (err) {
        console.error('Failed to load messages', err);
    }
}

function renderMessageBodyHtml(content) {
    const prefix = '__DATA_IMAGE__';
    if (content.startsWith(prefix)) {
        const url = content.slice(prefix.length);
        if (/^data:image\/(jpeg|jpg|png|gif|webp);base64,/i.test(url)) {
            return `<img class="msg-img" src="${url}" alt="Shared image" loading="lazy" />`;
        }
    }
    return `<span class="msg-text">${escapeHtml(content)}</span>`;
}

function getMessageStatusHtml(msg) {
    if (msg.sender_id !== state.user.id) return '';
    const status = state.messageStatuses.get(msg.id) || 'sent';
    const icons = {
        sent: '<i class="fas fa-check"></i>',
        delivered: '<i class="fas fa-check-double"></i>',
        read: '<i class="fas fa-check-double"></i>'
    };
    return `<span class="msg-status ${status}">${icons[status] || icons.sent}</span>`;
}

function getMessageActionsHtml(msg) {
    const isOwn = msg.sender_id === state.user.id;
    return `
        <div class="message-actions">
            <button class="message-action-btn react-btn" data-msg-id="${msg.id}" title="React">😊</button>
            ${isOwn ? `
                <button class="message-action-btn edit" data-msg-id="${msg.id}" title="Edit"><i class="fas fa-edit"></i></button>
                <button class="message-action-btn delete" data-msg-id="${msg.id}" title="Delete"><i class="fas fa-trash"></i></button>
            ` : ''}
        </div>
    `;
}

function formatMessageTime(dateStr) {
    const date = new Date(dateStr);
    const now = new Date();
    const diff = now - date;
    const oneDay = 24 * 60 * 60 * 1000;
    
    if (diff < oneDay) {
        return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } else if (diff < 7 * oneDay) {
        return date.toLocaleDateString([], { weekday: 'short' }) + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } else {
        return date.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
}

function renderMessages() {
    const area = elements.messagesArea;
    const force = state.forceScrollOnNextRender;
    state.forceScrollOnNextRender = false;
    const dist = area.scrollHeight - area.scrollTop - area.clientHeight;
    const wasNearBottom = force || dist < 120;

    area.innerHTML = '';
    state.messages.forEach((msg) => {
        const isMe = msg.sender_id === state.user.id;
        const msgDiv = document.createElement('div');
        msgDiv.className = `message ${isMe ? 'sent' : 'received'}`;
        msgDiv.dataset.msgId = msg.id;

        const senderName = !isMe
            ? `<span class="msg-sender">${escapeHtml(msg.profiles?.username || 'Unknown')}</span>`
            : '';
        const body = renderMessageBodyHtml(msg.content || '');
        const time = formatMessageTime(msg.created_at);
        const status = getMessageStatusHtml(msg);
        const actions = getMessageActionsHtml(msg);

        msgDiv.innerHTML = `
            ${senderName}
            ${body}
            <div class="msg-time">
                ${time}
                ${status}
            </div>
            ${actions}
        `;

        msgDiv.addEventListener('dblclick', () => {
            const plain = msg.content?.startsWith('__DATA_IMAGE__') ? 'Image message' : msg.content || '';
            navigator.clipboard.writeText(plain).then(
                () => showToast('Copied to clipboard'),
                () => showToast('Could not copy', 'error')
            );
        });

        const deleteBtn = msgDiv.querySelector('.delete');
        if (deleteBtn) {
            deleteBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                handleDeleteMessage(msg.id);
            });
        }

        const editBtn = msgDiv.querySelector('.edit');
        if (editBtn) {
            editBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                handleEditMessage(msg);
            });
        }

        const reactBtn = msgDiv.querySelector('.react-btn');
        if (reactBtn) {
            reactBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                showReactionPicker(msg.id);
            });
        }

        elements.messagesArea.appendChild(msgDiv);
    });

    if (wasNearBottom) {
        area.scrollTop = area.scrollHeight;
    }
    updateScrollBottomVisibility();
    updateGlobalChatPreview();
}

function updateScrollBottomVisibility() {
    const area = elements.messagesArea;
    const btn = elements.btnScrollBottom;
    if (!btn || !area) return;
    const dist = area.scrollHeight - area.scrollTop - area.clientHeight;
    btn.classList.toggle('hidden', dist < 100);
}

function scrollMessagesToBottom(force = false) {
    const area = elements.messagesArea;
    if (!area) return;
    
    const isAtBottom = area.scrollHeight - area.scrollTop - area.clientHeight < 150;
    if (force || isAtBottom) {
        area.scrollTo({
            top: area.scrollHeight,
            behavior: force ? 'auto' : 'smooth'
        });
    }
    updateScrollBottomVisibility();
}

function updateGlobalChatPreview() {
    if (state.activeConversation) return;
    const item = document.querySelector('[data-chat="global"]');
    if (!item) return;
    const last = state.messages[state.messages.length - 1];
    const lastEl = item.querySelector('.last-msg');
    const timeEl = item.querySelector('.chat-name .time');
    if (lastEl) {
        if (!last) {
            lastEl.textContent = 'Welcome to Vibely Chat!';
        } else {
            const who = last.sender_id === state.user.id ? 'You' : last.profiles?.username || 'Someone';
            const snippet = (last.content || '').startsWith('__DATA_IMAGE__')
                ? '📷 Photo'
                : last.content || '';
            const line = `${who}: ${snippet}`;
            lastEl.textContent = line.length > 48 ? `${line.slice(0, 46)}…` : line;
        }
    }
    if (timeEl && last?.created_at) {
        timeEl.textContent = formatMessageTime(last.created_at);
    }
}

async function handleDeleteMessage(msgId) {
    try {
        const messages = db.read('messages');
        const idx = messages.findIndex(m => m.id === msgId);
        if (idx !== -1) {
            messages.splice(idx, 1);
            db.write('messages', messages);
        }
        state.messages = state.messages.filter(m => m.id !== msgId);
        renderMessages();
        showToast('Message deleted');
    } catch (err) {
        showToast('Failed to delete message', 'error');
    }
}

function handleEditMessage(msg) {
    state.editingMessage = msg;
    elements.editMessageContainer.classList.remove('hidden');
    elements.editMessageInput.value = msg.content;
    elements.editMessageInput.focus();
}

async function saveEditedMessage() {
    if (!state.editingMessage) return;
    const newContent = elements.editMessageInput.value.trim();
    if (!newContent) return;

    try {
        const messages = db.read('messages');
        const msg = messages.find(m => m.id === state.editingMessage.id);
        if (msg) {
            msg.content = newContent;
            msg.edited_at = new Date().toISOString();
            db.write('messages', messages);
        }
        
        const stateMsg = state.messages.find(m => m.id === state.editingMessage.id);
        if (stateMsg) {
            stateMsg.content = newContent;
            stateMsg.edited_at = msg?.edited_at;
        }
        
        renderMessages();
        cancelEdit();
        showToast('Message edited');
    } catch (err) {
        showToast('Failed to edit message', 'error');
    }
}

function cancelEdit() {
    state.editingMessage = null;
    elements.editMessageContainer.classList.add('hidden');
    elements.editMessageInput.value = '';
}

function showReactionPicker(msgId) {
    showToast('React to message');
}

function updateUserStatus(userId, status) {
    state.userStatuses.set(userId, status);
    const chatHeader = document.querySelector('.chat-info');
    if (chatHeader && state.activeConversation) {
        const targetProfile = state.activeConversation.participantProfiles?.find(p => p.id === userId);
        if (targetProfile) {
            const indicator = chatHeader.querySelector('.online-indicator');
            if (indicator) {
                indicator.className = `online-indicator ${status}`;
            }
        }
    }
}

function initSoundToggle() {
    const btn = elements.btnSound;
    if (!btn) return;
    
    const icon = btn.querySelector('i');
    if (icon) {
        icon.className = state.soundEnabled ? 'fas fa-volume-up' : 'fas fa-volume-mute';
    }
    
    btn.addEventListener('click', () => {
        state.soundEnabled = !state.soundEnabled;
        localStorage.setItem('sound_enabled', state.soundEnabled);
        icon.className = state.soundEnabled ? 'fas fa-volume-up' : 'fas fa-volume-mute';
        showToast(state.soundEnabled ? 'Sound notifications on' : 'Sound notifications off');
    });
}

function playNotificationSound() {
    if (!state.soundEnabled) return;
}

async function loadGroupParticipants() {
    if (!elements.groupParticipants) return;
    try {
        const users = await api('/users/all');
        const currentUserId = state.user?.id;
        const filtered = (users || []).filter(u => u.id !== currentUserId);
        
        elements.groupParticipants.innerHTML = filtered.map(user => `
            <div class="participant-item" data-user-id="${user.id}">
                <input type="checkbox" value="${user.id}">
                <img src="${user.avatar_url || `https://ui-avatars.com/api/?name=${encodeURIComponent(user.username)}&background=random`}" alt="${user.username}">
                <span class="name">${escapeHtml(user.username)}</span>
            </div>
        `).join('');
        
        elements.groupParticipants.querySelectorAll('.participant-item').forEach(item => {
            item.addEventListener('click', (e) => {
                if (e.target.type !== 'checkbox') {
                    const cb = item.querySelector('input');
                    cb.checked = !cb.checked;
                }
                item.classList.toggle('selected', item.querySelector('input').checked);
            });
        });
    } catch (err) {
        console.error('Failed to load participants:', err);
    }
}

async function createGroupChat() {
    const name = elements.groupNameInput?.value.trim();
    if (!name) {
        showToast('Please enter a group name', 'error');
        return;
    }
    
    const selected = Array.from(elements.groupParticipants?.querySelectorAll('input:checked') || []);
    if (selected.length < 1) {
        showToast('Select at least one participant', 'error');
        return;
    }
    
    try {
        const participants = selected.map(cb => cb.value);
        const groupData = await api('/conversations/group', 'POST', {
            name,
            participants: [state.user.id, ...participants]
        });
        
        showToast('Group created successfully!');
        elements.groupModal?.classList.add('hidden');
        elements.groupNameInput.value = '';
        
        state.activeConversation = groupData;
        await loadMessages();
    } catch (err) {
        showToast(err.message || 'Failed to create group', 'error');
    }
}

function escapeHtml(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
}

async function sendMessage() {
    const content = elements.messageInput.value.trim();
    if (!content) return;

    const msgPayload = {
        sender_id: state.user.id,
        content,
        conversation_id: state.activeConversation?.id || null
    };

    state.forceScrollOnNextRender = true;

    if (state.syncMode === 'insforge') {
        try {
            const client = getInsForgeClient();
            await insforgeInsertMessage(client, msgPayload);
            elements.messageInput.value = '';
            await loadMessages();
        } catch (e) {
            showToast(e.message || 'Failed to send', 'error');
        }
    } else {
        if (!socket?.connected) {
            showToast('Not connected to chat server. Check that the API is running on port 3000.', 'error');
            return;
        }
        socket.emit('send_message', msgPayload);
        elements.messageInput.value = '';
    }
}

// --- SEARCH ---
let searchDebounceTimer;
let searchFocusedIndex = -1;
let currentSearchResults = [];

function highlightMatch(text, query) {
    if (!query) return escapeHtml(text);
    const safe = escapeHtml(text);
    const regex = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
    return safe.replace(regex, '<span class="search-highlight">$1</span>');
}

function showSearchDropdown() {
    elements.searchDropdown.classList.remove('hidden');
    elements.searchInputWrapper.classList.add('active');
}

function hideSearchDropdown() {
    elements.searchDropdown.classList.add('hidden');
    elements.searchInputWrapper.classList.remove('active');
    elements.searchLoading.classList.add('hidden');
    elements.searchEmpty.classList.add('hidden');
    elements.searchResultsList.innerHTML = '';
    searchFocusedIndex = -1;
    currentSearchResults = [];
}

function setSearchLoading(isLoading) {
    if (isLoading) {
        elements.searchLoading.classList.remove('hidden');
        elements.searchEmpty.classList.add('hidden');
        elements.searchResultsList.innerHTML = '';
    } else {
        elements.searchLoading.classList.add('hidden');
    }
}

function handleSearchInput(e) {
    const query = e.target.value.trim();
    clearTimeout(searchDebounceTimer);

    if (query.length > 0) {
        elements.searchClearBtn.classList.remove('hidden');
    } else {
        elements.searchClearBtn.classList.add('hidden');
        hideSearchDropdown();
        return;
    }

    showSearchDropdown();
    setSearchLoading(true);

    searchDebounceTimer = setTimeout(async () => {
        try {
            let users;
            if (state.syncMode === 'insforge') {
                users = await insforgeSearchUsers(getInsForgeClient(), state.user.id, query);
            } else {
                users = await api(`/users/search?query=${encodeURIComponent(query)}`);
            }
            const normalizedUsers = Array.isArray(users) ? users : [];
            currentSearchResults = normalizedUsers;
            searchFocusedIndex = -1;
            renderSearchResults(normalizedUsers, query);
        } catch (err) {
            console.error('Search failed:', err);
            setSearchLoading(false);
            elements.searchEmpty.querySelector('span').textContent = 'Search failed';
            elements.searchEmpty.classList.remove('hidden');
        }
    }, 300);
}

function renderSearchResults(users, query) {
    setSearchLoading(false);

    if (users.length === 0) {
        elements.searchEmpty.querySelector('span').textContent = 'No users found';
        elements.searchEmpty.classList.remove('hidden');
        elements.searchResultsList.innerHTML = '';
        return;
    }

    elements.searchEmpty.classList.add('hidden');
    elements.searchResultsList.innerHTML =
        `<div class="search-section-header">Users — ${users.length} result${users.length > 1 ? 's' : ''}</div>` +
        users
            .map(
                (user, idx) => `
            <div class="search-result-item${idx === searchFocusedIndex ? ' focused' : ''}" 
                 data-user-id="${escapeHtml(user.id)}" 
                 data-user-name="${escapeHtml(user.username)}"
                 data-index="${idx}">
                <div class="search-result-avatar-wrapper">
                    <img class="search-result-avatar" src="${user.avatar_url || `https://ui-avatars.com/api/?name=${encodeURIComponent(user.username)}&background=random`}" alt="${escapeHtml(user.username)}">
                </div>
                <div class="search-result-info">
                    <div class="search-result-name">${highlightMatch(user.username, query)}</div>
                    <div class="search-result-email">${highlightMatch(user.email || '', query)}</div>
                    <div class="search-result-id" style="font-size: 0.75rem; color: var(--text-muted);">${highlightMatch(user.id || '', query)}</div>
                </div>
                <div class="search-result-action">
                    <i class="fas fa-comment-dots"></i> Chat
                </div>
            </div>
        `
            )
            .join('');

    elements.searchResultsList.querySelectorAll('.search-result-item').forEach((item) => {
        item.addEventListener('click', () => {
            startChat(item.dataset.userId, item.dataset.userName);
        });
    });
}

function handleSearchKeydown(e) {
    if (elements.searchDropdown.classList.contains('hidden')) return;
    const items = elements.searchResultsList.querySelectorAll('.search-result-item');
    if (items.length === 0) return;

    if (e.key === 'ArrowDown') {
        e.preventDefault();
        searchFocusedIndex = Math.min(searchFocusedIndex + 1, items.length - 1);
        updateSearchFocus(items);
    } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        searchFocusedIndex = Math.max(searchFocusedIndex - 1, 0);
        updateSearchFocus(items);
    } else if (e.key === 'Enter' && searchFocusedIndex >= 0) {
        e.preventDefault();
        const focused = items[searchFocusedIndex];
        if (focused) {
            startChat(focused.dataset.userId, focused.dataset.userName);
        }
    } else if (e.key === 'Escape') {
        clearSearch();
        elements.searchInput.blur();
    }
}

function updateSearchFocus(items) {
    items.forEach((item, idx) => {
        item.classList.toggle('focused', idx === searchFocusedIndex);
    });
    if (searchFocusedIndex >= 0 && items[searchFocusedIndex]) {
        items[searchFocusedIndex].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
}

function clearSearch() {
    elements.searchInput.value = '';
    elements.searchClearBtn.classList.add('hidden');
    hideSearchDropdown();
}

function resetGlobalChatHeader() {
    const chatHeader = document.querySelector('.chat-header .chat-info');
    if (!chatHeader) return;
    const img = chatHeader.querySelector('img');
    const h3 = chatHeader.querySelector('h3');
    const p = chatHeader.querySelector('p');
    if (img)
        img.src =
            'https://ui-avatars.com/api/?name=Public+Chat&background=25D366&color=fff';
    if (h3) h3.textContent = 'Global Room';
    if (p) p.textContent = 'Public messaging for everyone';
    document.querySelector('[data-chat="global"]')?.classList.add('active');
}

async function startChat(targetUserId, targetName) {
    hideSearchDropdown();
    elements.searchInput.value = '';
    elements.searchClearBtn.classList.add('hidden');

    showToast(`Opening chat with ${targetName}...`);

    try {
        let convo;
        if (state.syncMode === 'insforge') {
            convo = await insforgeGetOrCreateDm(getInsForgeClient(), state.user.id, targetUserId);
        } else {
            convo = await api('/conversations/dm', 'POST', { targetUserId });
        }
        state.activeConversation = convo;
        document.querySelector('[data-chat="global"]')?.classList.remove('active');

        const chatHeader = document.querySelector('.chat-info');
        if (chatHeader) {
            const headerImg = chatHeader.querySelector('img');
            const headerTitle = chatHeader.querySelector('h3');
            const headerSubtitle = chatHeader.querySelector('p');

            if (convo.type === 'group') {
                if (headerImg) {
                    headerImg.src = `https://ui-avatars.com/api/?name=${encodeURIComponent(convo.name || 'Group')}&background=25D366&color=fff`;
                }
                if (headerTitle) {
                    headerTitle.textContent = convo.name || 'Group Chat';
                }
                if (headerSubtitle) {
                    const count = convo.participantProfiles?.length || 0;
                    headerSubtitle.textContent = `${count} participants`;
                }
                
                let wrapper = chatHeader.querySelector('.avatar-wrapper');
                if (!wrapper) {
                    wrapper = document.createElement('div');
                    wrapper.className = 'avatar-wrapper';
                    headerImg.parentNode.insertBefore(wrapper, headerImg);
                    wrapper.appendChild(headerImg);
                }
                const indicator = wrapper.querySelector('.online-indicator') || document.createElement('div');
                indicator.className = 'online-indicator';
                if (!wrapper.querySelector('.online-indicator')) {
                    wrapper.appendChild(indicator);
                }
            } else {
                const targetProfile = convo.participantProfiles?.find((p) => p.id !== state.user.id);
                if (targetProfile && headerImg) {
                    headerImg.src =
                        targetProfile.avatar_url ||
                        `https://ui-avatars.com/api/?name=${encodeURIComponent(targetProfile.username)}&background=random`;
                }
                if (headerTitle && convo.participantProfiles) {
                    const targetProfile = convo.participantProfiles.find(p => p.id !== state.user.id);
                    headerTitle.textContent = targetProfile?.username || 'Chat';
                }
                if (headerSubtitle) {
                    headerSubtitle.textContent = 'Direct Message';
                }
                
                let wrapper = chatHeader.querySelector('.avatar-wrapper');
                if (!wrapper) {
                    wrapper = document.createElement('div');
                    wrapper.className = 'avatar-wrapper';
                    headerImg.parentNode.insertBefore(wrapper, headerImg);
                    wrapper.appendChild(headerImg);
                }
                let indicator = wrapper.querySelector('.online-indicator');
                if (!indicator) {
                    indicator = document.createElement('div');
                    indicator.className = 'online-indicator';
                    wrapper.appendChild(indicator);
                }
                const isOnline = state.onlineUsers.has(targetUserId);
                indicator.className = `online-indicator ${isOnline ? 'online' : 'offline'}`;
            }
        }

        await loadMessages();

        if (window.innerWidth <= 768) {
            document.getElementById('chat-window').classList.add('active');
        }

        showToast(`Chat with ${targetName} opened!`);
    } catch (err) {
        console.error('Failed to start chat:', err);
    }
}

document.addEventListener('click', (e) => {
    if (!e.target.closest('.search-bar')) {
        hideSearchDropdown();
    }
});

// --- SOCKET (local only) ---

function initSocket() {
    if (state.syncMode === 'insforge') return;
    if (socket) {
        socket.removeAllListeners();
        socket.disconnect();
        socket = null;
    }
    if (!SOCKET_URL) {
        showToast(STATIC_API_CONFIG_ERROR, 'error');
        return;
    }
    socket = io(SOCKET_URL, { transports: ['websocket', 'polling'] });

    socket.on('connect', () => {
        console.log('Connected to socket server');
        socket.emit('join', state.user.id);
    });

    socket.on('new_message', (msg) => {
        const activeConv = normalizeConversationId(state.activeConversation?.id);
        const msgConv = normalizeConversationId(msg.conversation_id);
        if (msgConv !== activeConv) return;
        
        if (state.soundEnabled && msg.sender_id !== state.user.id) {
            playNotificationSound();
        }
        
        state.messages.push(msg);
        state.messageStatuses.set(msg.id, 'delivered');
        renderMessages();
        
        socket.emit('message_read', { messageId: msg.id, conversationId: activeConv });
    });

    socket.on('user_status', (data) => {
        console.log('User status update:', data);
        if (data.status === 'online') {
            state.onlineUsers.add(data.userId);
        } else {
            state.onlineUsers.delete(data.userId);
        }
        
        if (state.activeConversation) {
            const targetProfile = state.activeConversation.participantProfiles?.find(p => p.id === data.userId);
            if (targetProfile) {
                const chatHeader = document.querySelector('.chat-info');
                const indicator = chatHeader?.querySelector('.online-indicator');
                if (indicator) {
                    indicator.className = `online-indicator ${data.status}`;
                }
                const subtitle = chatHeader?.querySelector('p');
                if (subtitle && !state.activeConversation?.type === 'group') {
                    subtitle.textContent = data.status === 'online' ? 'Online' : 'Offline';
                }
            }
        }
    });

    socket.on('typing', (data) => {
        if (data.userId !== state.user.id) {
            showTyping(data.username);
        }
    });
    
    socket.on('message_status', (data) => {
        if (data.messageId) {
            state.messageStatuses.set(data.messageId, data.status);
            renderMessages();
        }
    });
}

function showTyping(username) {
    if (!elements.typingIndicator) {
        elements.typingIndicator = document.createElement('div');
        elements.typingIndicator.className = 'typing-status';
        elements.messagesArea.parentElement.insertBefore(
            elements.typingIndicator,
            elements.messagesArea.nextSibling
        );
    }
    elements.typingIndicator.textContent = `${username} is typing...`;
    clearTimeout(state.typingTimeout);
    state.typingTimeout = setTimeout(() => {
        elements.typingIndicator.textContent = '';
    }, 2000);
}

function emitTyping() {
    if (state.syncMode === 'insforge' || !socket) return;
    socket.emit('typing', { userId: state.user.id, username: state.user.username });
}

function wireGlobalRoomNav() {
    const firstItem = document.querySelector('[data-chat="global"]');
    if (!firstItem || firstItem.dataset.globalWired === '1') return;
    firstItem.dataset.globalWired = '1';
    firstItem.addEventListener('click', () => {
        state.activeConversation = null;
        firstItem.classList.add('active');
        resetGlobalChatHeader();
        loadMessages();
    });
}

// --- INITIALIZATION ---

function applyTheme(isDark) {
    document.documentElement.dataset.theme = isDark ? 'dark' : 'light';
    localStorage.setItem(THEME_KEY, isDark ? 'dark' : 'light');
    if (elements.btnThemeIcon) {
        elements.btnThemeIcon.className = isDark ? 'fas fa-sun' : 'fas fa-moon';
    }
    if (elements.btnTheme) {
        elements.btnTheme.title = isDark ? 'Switch to light mode' : 'Switch to dark mode';
    }
}

function initTheme() {
    const stored = localStorage.getItem(THEME_KEY);
    const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches;
    applyTheme(stored === 'dark' || (!stored && prefersDark));
}

function toggleTheme() {
    const next = document.documentElement.dataset.theme !== 'dark';
    applyTheme(next);
}

function populateEmojiPopover() {
    const pop = elements.emojiPopover;
    if (!pop || pop.dataset.built === '1') return;
    pop.dataset.built = '1';
    pop.innerHTML = '';
    for (const ch of EMOJI_PRESET) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = ch;
        b.addEventListener('click', () => {
            insertEmojiAtCursor(ch);
            closeEmojiPopover();
        });
        pop.appendChild(b);
    }
}

function insertEmojiAtCursor(emoji) {
    const input = elements.messageInput;
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? input.value.length;
    const v = input.value;
    input.value = v.slice(0, start) + emoji + v.slice(end);
    input.focus();
    const pos = start + emoji.length;
    input.setSelectionRange(pos, pos);
}

function toggleEmojiPopover() {
    populateEmojiPopover();
    elements.emojiPopover?.classList.toggle('hidden');
}

function closeEmojiPopover() {
    elements.emojiPopover?.classList.add('hidden');
}

function wireChatFeatures() {
    if (state.chatFeaturesWired) return;
    state.chatFeaturesWired = true;

    elements.btnTheme?.addEventListener('click', toggleTheme);

    elements.btnScrollBottom?.addEventListener('click', () => {
        state.forceScrollOnNextRender = true;
        scrollMessagesToBottom();
    });

    elements.messagesArea?.addEventListener('scroll', () => updateScrollBottomVisibility());

    elements.btnEmoji?.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleEmojiPopover();
    });

    elements.btnAttach?.addEventListener('click', () => elements.imageInput?.click());

    elements.imageInput?.addEventListener('change', async () => {
        const file = elements.imageInput.files?.[0];
        elements.imageInput.value = '';
        if (!file || !file.type.startsWith('image/')) return;
        if (file.size > 400_000) {
            showToast('Image too large (max ~400KB for inline send)', 'error');
            return;
        }
        const dataUrl = await new Promise((res, rej) => {
            const r = new FileReader();
            r.onload = () => res(r.result);
            r.onerror = rej;
            r.readAsDataURL(file);
        });
        if (String(dataUrl).length > 100_000) {
            showToast('Image still too large after encoding', 'error');
            return;
        }
        const content = `__DATA_IMAGE__${dataUrl}`;
        const msgPayload = {
            sender_id: state.user.id,
            content,
            conversation_id: state.activeConversation?.id || null
        };
        state.forceScrollOnNextRender = true;
        try {
            if (state.syncMode === 'insforge') {
                await insforgeInsertMessage(getInsForgeClient(), msgPayload);
                await loadMessages();
                showToast('Image sent');
            } else if (socket?.connected) {
                socket.emit('send_message', msgPayload);
                showToast('Image sent');
            } else {
                showToast('Not connected to chat server.', 'error');
                return;
            }
        } catch (err) {
            showToast(err.message || 'Failed to send image', 'error');
        }
    });

    document.addEventListener('click', (e) => {
        if (!e.target.closest('#btn-emoji') && !e.target.closest('#emoji-popover')) {
            closeEmojiPopover();
        }
    });

    document.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
            if (!elements.chatContainer || elements.chatContainer.classList.contains('hidden')) return;
            e.preventDefault();
            elements.searchInput?.focus();
            elements.searchInput?.select();
        }
    });

    elements.btnSound?.addEventListener('click', () => {
        state.soundEnabled = !state.soundEnabled;
        localStorage.setItem('sound_enabled', state.soundEnabled);
        const icon = elements.btnSound.querySelector('i');
        if (icon) icon.className = state.soundEnabled ? 'fas fa-volume-up' : 'fas fa-volume-mute';
        showToast(state.soundEnabled ? 'Sound on' : 'Sound off');
    });

    elements.btnGroup?.addEventListener('click', () => {
        elements.groupModal?.classList.remove('hidden');
        loadGroupParticipants();
    });

    document.getElementById('close-group-modal')?.addEventListener('click', () => {
        elements.groupModal?.classList.add('hidden');
    });

    document.getElementById('cancel-group-btn')?.addEventListener('click', () => {
        elements.groupModal?.classList.add('hidden');
    });

    document.getElementById('create-group-btn')?.addEventListener('click', createGroupChat);

    elements.saveEditBtn?.addEventListener('click', saveEditedMessage);
    elements.cancelEditBtn?.addEventListener('click', cancelEdit);

    elements.editMessageInput?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            saveEditedMessage();
        } else if (e.key === 'Escape') {
            cancelEdit();
        }
    });

    document.getElementById('fab-search')?.addEventListener('click', () => {
        elements.searchInput?.focus();
    });

    document.getElementById('fab-new-chat')?.addEventListener('click', () => {
        elements.searchInput?.focus();
    });
}

function setupApp() {
    elements.authContainer.classList.add('hidden');
    elements.chatContainer.classList.remove('hidden');

    const uname = state.user?.username || state.user?.email || 'User';
    elements.myUsername.textContent = uname;
    elements.myAvatar.src =
        state.user?.avatar_url ||
        `https://ui-avatars.com/api/?name=${encodeURIComponent(uname)}&background=random`;

    // Show/hide admin link based on role
    if (elements.adminLink) {
        const role = state.user?.role || 'user';
        const hasAdminAccess = ['admin', 'sub_admin', 'editor'].includes(role);
        elements.adminLink.classList.toggle('hidden', !hasAdminAccess);
    }

    wireChatFeatures();
    initSocket();
    loadMessages();
    wireGlobalRoomNav();

    if (state.syncMode === 'insforge') {
        if (messagePollTimer) clearInterval(messagePollTimer);
        messagePollTimer = setInterval(() => loadMessages(), 2800);
    }
}

async function checkSession() {
    if (state.syncMode === 'insforge') {
        handleInsforgeAuthRedirectMessage();
        await loadInsforgePublicAuthConfig();
        const client = getInsForgeClient();
        await client.auth.getCurrentUser();

        let u = await hydrateInsforgeSession(client);
        if (!u) {
            const synced = await persistMemorySessionIfAny(client);
            if (synced) u = synced;
        }
        if (u) {
            state.user = u;
            state.token = localStorage.getItem('chat_token');
            try {
                await upsertProfileRow(client, u);
            } catch (e) {
                console.warn('Profile sync:', e);
            }
            setupApp();
            return;
        }
        if (sessionStorage.getItem('pending_verify_email')) {
            state.pendingVerifyEmail = sessionStorage.getItem('pending_verify_email');
            showAuthForm(isInsforgeCodeVerificationMode() ? 'verify' : 'login');
        } else {
            elements.loginEmail.value = localStorage.getItem(LAST_EMAIL_KEY) || '';
        }
        elements.authContainer.classList.remove('hidden');
        elements.loginEmail.value = localStorage.getItem(LAST_EMAIL_KEY) || state.pendingVerifyEmail || '';
        return;
    }

    if (!API_URL && isStaticHostingOrigin()) {
        elements.authContainer.classList.remove('hidden');
        showToast(STATIC_API_CONFIG_ERROR, 'error');
        return;
    }

    state.token = localStorage.getItem('chat_token');
    const storedUser = localStorage.getItem('chat_user');
    if (state.token && storedUser) {
        try {
            state.user = JSON.parse(storedUser);
            setupApp();
        } catch {
            localStorage.removeItem('chat_user');
            localStorage.removeItem('chat_token');
            localStorage.removeItem(BACKEND_KEY);
            state.token = null;
            elements.authContainer.classList.remove('hidden');
            elements.loginEmail.value = localStorage.getItem(LAST_EMAIL_KEY) || '';
        }
    } else {
        elements.authContainer.classList.remove('hidden');
        elements.loginEmail.value = localStorage.getItem(LAST_EMAIL_KEY) || '';
    }
}

elements.showSignup.onclick = () => showAuthForm('signup');

elements.showLogin.onclick = () => showAuthForm('login');

elements.btnLogin.onclick = handleLogin;
elements.btnSignup.onclick = handleSignup;
elements.loginPass.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        e.preventDefault();
        handleLogin();
    }
});
elements.loginEmail.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        e.preventDefault();
        handleLogin();
    }
});
elements.signupPass.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        e.preventDefault();
        handleSignup();
    }
});
elements.signupEmail.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        e.preventDefault();
        handleSignup();
    }
});
elements.signupUser.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        e.preventDefault();
        handleSignup();
    }
});
elements.btnVerify.onclick = handleVerifyEmail;
elements.resendCode.onclick = handleResendVerification;
elements.btnGoogle.onclick = () => handleOAuth('google');
elements.btnGithub.onclick = () => handleOAuth('github');
elements.btnLogout.onclick = handleLogout;
elements.btnSend.onclick = sendMessage;
elements.messageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
    }
});
elements.messageInput.addEventListener('input', emitTyping);

elements.searchInput.addEventListener('input', handleSearchInput);
elements.searchInput.addEventListener('keydown', handleSearchKeydown);
elements.searchClearBtn.addEventListener('click', clearSearch);

document.addEventListener('click', (e) => {
    if (window.innerWidth <= 768) {
        const chatItem = e.target.closest('.chat-item');
        if (chatItem) {
            document.getElementById('chat-window').classList.add('active');
        }

        const backBtn = e.target.closest('.back-btn');
        if (backBtn) {
            document.getElementById('chat-window').classList.remove('active');
        }
    }
});

initTheme();
if (elements.loginEmail) elements.loginEmail.value = 'zzarda67@gmail.com';
if (elements.loginPass) elements.loginPass.value = 'admin123';

void checkSession();
