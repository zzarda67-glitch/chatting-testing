import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { db, ensureDataDir } from './lib/jsonDb.js';
import { migrateUsers } from './lib/migrateUsers.js';
import { getJwtSecret } from './middleware/adminAuth.js';
import { createAdminRouter } from './routes/admin.js';
import { createPasswordRouter } from './routes/authPassword.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST']
    }
});

const PORT = process.env.PORT || 3000;
const uploadDir = path.join(__dirname, 'uploads');

ensureDataDir();
migrateUsers(process.env.ADMIN_BOOTSTRAP_EMAIL);

app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(
    cors({
        origin: process.env.CORS_ORIGIN || true,
        credentials: Boolean(process.env.CORS_ORIGIN)
    })
);
app.use(express.json({ limit: '15mb' }));

const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: Number(process.env.AUTH_RATE_LIMIT_MAX) || 120,
    standardHeaders: true,
    legacyHeaders: false
});

function authMiddleware(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ message: 'No token provided' });
    const token = authHeader.split(' ')[1];
    try {
        const decoded = jwt.verify(token, getJwtSecret());
        req.userId = decoded.id;
        next();
    } catch {
        res.status(401).json({ message: 'Invalid token' });
    }
}

// --- AUTH ENDPOINTS ---

app.post('/register', authLimiter, async (req, res) => {
    const { username, email, password } = req.body;
    const normalizedEmail = String(email ?? '').trim().toLowerCase();
    const cleanUsername = String(username ?? '').trim();
    if (!cleanUsername || !normalizedEmail || !password) return res.status(400).json({ message: 'Missing fields' });
    if (String(password).length < 8) {
        return res.status(400).json({ message: 'Password must be at least 8 characters' });
    }
    if (cleanUsername.length > 64 || normalizedEmail.length > 254) {
        return res.status(400).json({ message: 'Invalid username or email length' });
    }
    const users = db.read('users');
    if (users.find((u) => u.email === normalizedEmail)) {
        return res.status(400).json({ message: 'User already exists' });
    }

    console.log(`Registering user: ${cleanUsername} (${normalizedEmail})`);
    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = {
        id: randomUUID(),
        username: cleanUsername,
        email: normalizedEmail,
        password: hashedPassword,
        avatar_url: `https://ui-avatars.com/api/?name=${encodeURIComponent(cleanUsername)}&background=random`,
        role: 'user',
        status: 'active',
        created_at: new Date().toISOString()
    };

    users.push(newUser);
    db.write('users', users);

    const token = jwt.sign(
        { id: newUser.id, role: newUser.role },
        getJwtSecret(),
        { expiresIn: '7d' }
    );
    const { password: _, ...userWithoutPassword } = newUser;
    res.status(201).json({ user: userWithoutPassword, token });
});

app.post('/login', authLimiter, async (req, res) => {
    const { email, password } = req.body;
    const normalizedEmail = String(email ?? '').trim().toLowerCase();
    if (!normalizedEmail || password == null || password === '') {
        return res.status(400).json({ message: 'Email and password are required' });
    }
    console.log(`Login attempt: ${normalizedEmail}`);

    const users = db.read('users');
    const user = users.find((u) => u.email === normalizedEmail);

    if (!user) {
        console.log(`Login failed: User ${normalizedEmail} not found`);
        return res.status(401).json({ message: 'Invalid credentials' });
    }

    if (user.status === 'banned') {
        return res.status(403).json({ message: 'Account suspended' });
    }
    if (user.status === 'inactive') {
        return res.status(403).json({ message: 'Account disabled' });
    }

    if (!user.password || typeof user.password !== 'string') {
        return res.status(401).json({ message: 'Invalid credentials' });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
        console.log(`Login failed: Wrong password for ${normalizedEmail}`);
        return res.status(401).json({ message: 'Invalid credentials' });
    }

    const role = user.role || 'user';
    const token = jwt.sign({ id: user.id, role }, getJwtSecret(), { expiresIn: '7d' });
    const { password: _, ...userWithoutPassword } = user;
    res.json({ user: userWithoutPassword, token });
});

// --- USER SEARCH (Authenticated, excludes self) ---
app.get('/users/search', authMiddleware, (req, res) => {
    const query = req.query.query || req.query.q || '';
    if (!query || query.length < 1) return res.json([]);

    const users = db.read('users');
    const q = query.toLowerCase();
    const filtered = users
        .filter((u) => u.id !== req.userId)
        .filter((u) => u.status !== 'banned' && u.status !== 'inactive')
        .filter(
            (u) =>
                u.username.toLowerCase().includes(q) ||
                u.email.toLowerCase().includes(q) ||
                u.id.toLowerCase().includes(q)
        )
        .map(({ password, ...rest }) => rest)
        .slice(0, 15);

    res.json(filtered);
});

// --- CONVERSATIONS (DMs) ---
app.post('/conversations/dm', authMiddleware, (req, res) => {
    const { targetUserId } = req.body;
    if (!targetUserId) return res.status(400).json({ message: 'targetUserId required' });
    if (targetUserId === req.userId) {
        return res.status(400).json({ message: 'Cannot start a DM with yourself' });
    }

    const allUsers = db.read('users');
    const target = allUsers.find((u) => u.id === targetUserId);
    if (!target) return res.status(404).json({ message: 'User not found' });
    if (target.status && target.status !== 'active') {
        return res.status(403).json({ message: 'Cannot message this user' });
    }

    const conversations = db.read('conversations');
    let convo = conversations.find(
        (c) =>
            c.type === 'dm' &&
            c.participants.includes(req.userId) &&
            c.participants.includes(targetUserId)
    );

    if (!convo) {
        convo = {
            id: randomUUID(),
            type: 'dm',
            participants: [req.userId, targetUserId],
            created_at: new Date().toISOString()
        };
        conversations.push(convo);
        db.write('conversations', conversations);
    }

    const users = db.read('users');
    const participantProfiles = convo.participants.map((pid) => {
        const u = users.find((x) => x.id === pid);
        if (!u) return { id: pid, username: 'Unknown' };
        const { password, ...rest } = u;
        return rest;
    });

    res.json({ ...convo, participantProfiles });
});

// --- GROUP CHAT ---
app.post('/conversations/group', authMiddleware, (req, res) => {
    const { name, participants } = req.body;
    if (!name || !Array.isArray(participants) || participants.length < 2) {
        return res.status(400).json({ message: 'Group name and at least 2 participants required' });
    }

    const allUsers = db.read('users');
    const validParticipants = participants.filter(pid => {
        const u = allUsers.find(x => x.id === pid);
        return u && u.status === 'active';
    });

    if (validParticipants.length < 2) {
        return res.status(400).json({ message: 'At least 2 valid active participants required' });
    }

    const conversations = db.read('conversations');
    const newConvo = {
        id: randomUUID(),
        type: 'group',
        name: String(name).trim(),
        participants: validParticipants,
        created_by: req.userId,
        created_at: new Date().toISOString()
    };
    conversations.push(newConvo);
    db.write('conversations', conversations);

    const participantProfiles = validParticipants.map(pid => {
        const u = allUsers.find(x => x.id === pid);
        if (!u) return { id: pid, username: 'Unknown' };
        const { password, ...rest } = u;
        return rest;
    });

    res.json({ ...newConvo, participantProfiles });
});

// --- GET USER CONVERSATIONS ---
app.get('/conversations', authMiddleware, (req, res) => {
    const conversations = db.read('conversations');
    const users = db.read('users');
    const messages = db.read('messages');

    const myConvos = conversations
        .filter((c) => c.participants.includes(req.userId))
        .map((c) => {
            const participantProfiles = c.participants.map((pid) => {
                const u = users.find((x) => x.id === pid);
                if (!u) return { id: pid, username: 'Unknown' };
                const { password, ...rest } = u;
                return rest;
            });
            const convoMessages = messages.filter((m) => m.conversation_id === c.id);
            const lastMessage = convoMessages.length > 0 ? convoMessages[convoMessages.length - 1] : null;
            return { ...c, participantProfiles, lastMessage };
        })
        .sort((a, b) => {
            const aTime = a.lastMessage?.created_at || a.created_at;
            const bTime = b.lastMessage?.created_at || b.created_at;
            return new Date(bTime) - new Date(aTime);
        });

    res.json(myConvos);
});

// --- MESSAGES ENDPOINTS (auth required; DM threads only for participants) ---
app.get('/messages', authMiddleware, (req, res) => {
    const { conversation_id } = req.query;
    const allMessages = db.read('messages');
    const conversations = db.read('conversations');

    if (conversation_id) {
        const convo = conversations.find((c) => c.id === conversation_id);
        if (!convo || !convo.participants.includes(req.userId)) {
            return res.status(403).json({ message: 'Access denied' });
        }
    }

    const messages = conversation_id
        ? allMessages.filter((m) => m.conversation_id === conversation_id)
        : allMessages.filter((m) => m.conversation_id == null || m.conversation_id === '');
    const users = db.read('users');
    const messagesWithProfiles = messages.map((msg) => {
        const u = users.find((x) => x.id === msg.sender_id);
        const { password, ...profile } = u || {};
        return { ...msg, profiles: profile };
    });
    res.json(messagesWithProfiles);
});

// --- EDIT MESSAGE ---
app.put('/messages/:id', authMiddleware, (req, res) => {
    const { id } = req.params;
    const { content } = req.body;
    if (!content || typeof content !== 'string' || content.length === 0) {
        return res.status(400).json({ message: 'Content required' });
    }
    if (content.length > 8000) {
        return res.status(400).json({ message: 'Content too long' });
    }

    const messages = db.read('messages');
    const msg = messages.find((m) => String(m.id) === String(id));
    if (!msg) {
        return res.status(404).json({ message: 'Message not found' });
    }
    if (msg.sender_id !== req.userId) {
        return res.status(403).json({ message: 'Cannot edit others\' messages' });
    }

    msg.content = content;
    msg.edited_at = new Date().toISOString();
    db.write('messages', messages);

    const users = db.read('users');
    const u = users.find((x) => x.id === msg.sender_id);
    const { password, ...profile } = u || {};
    res.json({ ...msg, profiles: profile });
});

// --- DELETE MESSAGE ---
app.delete('/messages/:id', authMiddleware, (req, res) => {
    const { id } = req.params;
    const messages = db.read('messages');
    const idx = messages.findIndex((m) => String(m.id) === String(id));
    if (idx === -1) {
        return res.status(404).json({ message: 'Message not found' });
    }
    const msg = messages[idx];
    if (msg.sender_id !== req.userId) {
        return res.status(403).json({ message: 'Cannot delete others\' messages' });
    }

    messages.splice(idx, 1);
    db.write('messages', messages);
    res.json({ message: 'Message deleted' });
});

// --- GET ALL USERS (for group creation) ---
app.get('/users/all', authMiddleware, (req, res) => {
    const users = db.read('users');
    const filtered = users
        .filter((u) => u.id !== req.userId)
        .filter((u) => u.status === 'active')
        .map(({ password, ...rest }) => rest);
    res.json(filtered);
});

// --- ADMIN + AUTH API ---
app.use('/api/auth', authLimiter, createPasswordRouter());
app.use('/api/admin', createAdminRouter({ io }));

if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
app.use('/uploads', express.static(uploadDir));

const adminDist = path.join(__dirname, 'admin-ui', 'dist');
const adminIndex = path.resolve(adminDist, 'index.html');
const adminMissingHtml = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Admin panel — build required</title><style>body{font-family:system-ui,sans-serif;max-width:36rem;margin:3rem auto;padding:0 1rem;line-height:1.5}</style></head>
<body><h1>Admin UI is not built yet</h1>
<p>The server is running, but <code>admin-ui/dist</code> is missing.</p>
<p>From the project root run:</p>
<pre style="background:#f4f4f5;padding:1rem;border-radius:8px">npm run build:admin</pre>
<p>Then restart the server and open <a href="/admin">/admin</a> again.</p>
<p>For local dev you can also use the API on this port: <code>/api/admin</code></p>
</body></html>`;

if (fs.existsSync(adminIndex)) {
    app.use('/admin', express.static(adminDist));
    app.use('/admin', (req, res, next) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') return next();
        res.sendFile(adminIndex, (err) => (err ? next(err) : undefined));
    });
} else {
    app.use('/admin', (_req, res) => {
        res.status(503).type('html').send(adminMissingHtml);
    });
}

// --- SOCKET.IO REALTIME ---
const onlineUsers = new Map(); // userId -> socket.id (last connection wins)
const socketUser = new Map(); // socket.id -> userId

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    socket.on('admin_join', (token) => {
        try {
            const decoded = jwt.verify(String(token || ''), getJwtSecret());
            const users = db.read('users');
            const u = users.find((x) => x.id === decoded.id);
            const role = u?.role || 'user';
            if (u && ['admin', 'sub_admin', 'editor'].includes(role)) {
                socket.join('admin_notifications');
            }
        } catch {
            /* ignore */
        }
    });

    socket.on('join', (userId) => {
        if (!userId || typeof userId !== 'string') return;
        socketUser.set(socket.id, userId);
        onlineUsers.set(userId, socket.id);
        io.emit('user_status', { userId, status: 'online' });
    });

    socket.on('send_message', (msgData) => {
        const senderId = socketUser.get(socket.id);
        if (!senderId || !msgData || typeof msgData !== 'object') return;

        const rawContent = msgData.content;
        if (typeof rawContent !== 'string' || rawContent.length === 0) return;
        const maxLen = 8000;
        if (rawContent.length > maxLen) return;

        const rawCid = msgData.conversation_id;
        const conversationId =
            rawCid != null && String(rawCid).trim() !== '' ? String(rawCid).trim() : null;
        if (conversationId) {
            const conversations = db.read('conversations');
            const convo = conversations.find((c) => c.id === conversationId);
            if (!convo || !convo.participants.includes(senderId)) return;
        }

        const messages = db.read('messages');
        const newMessage = {
            id: Date.now(),
            sender_id: senderId,
            content: rawContent,
            conversation_id: conversationId,
            created_at: new Date().toISOString()
        };
        messages.push(newMessage);
        db.write('messages', messages);

        const users = db.read('users');
        const u = users.find((x) => x.id === senderId);
        const { password, ...profiles } = u || {};

        if (conversationId) {
            const conversations = db.read('conversations');
            const convo = conversations.find((c) => c.id === conversationId);
            if (convo) {
                convo.participants.forEach((pid) => {
                    const targetSocket = onlineUsers.get(pid);
                    if (targetSocket) {
                        io.to(targetSocket).emit('new_message', { ...newMessage, profiles });
                    }
                });
            }
        } else {
            io.emit('new_message', { ...newMessage, profiles });
        }
    });

    socket.on('typing', (data) => {
        const uid = socketUser.get(socket.id);
        if (!uid || !data || data.userId !== uid) return;
        const users = db.read('users');
        const u = users.find((x) => x.id === uid);
        socket.broadcast.emit('typing', { userId: uid, username: u?.username || data.username || 'Someone' });
    });

    socket.on('message_read', (data) => {
        const { messageId, conversationId } = data || {};
        if (!messageId || !conversationId) return;
        
        const conversations = db.read('conversations');
        const convo = conversations.find((c) => c.id === conversationId);
        if (!convo || !convo.participants.includes(socketUser.get(socket.id))) return;
        
        const senderId = socketUser.get(socket.id);
        if (!senderId) return;
        
        convo.participants.forEach((pid) => {
            if (pid !== senderId) {
                const targetSocket = onlineUsers.get(pid);
                if (targetSocket) {
                    io.to(targetSocket).emit('message_status', { messageId, status: 'read' });
                }
            }
        });
    });

    socket.on('disconnect', () => {
        const uid = socketUser.get(socket.id);
        socketUser.delete(socket.id);

        let disconnectedUserId = null;
        if (uid && onlineUsers.get(uid) === socket.id) {
            onlineUsers.delete(uid);
            disconnectedUserId = uid;
        }
        if (disconnectedUserId) {
            io.emit('user_status', { userId: disconnectedUserId, status: 'offline' });
        }
        console.log('User disconnected');
    });
});

httpServer.on('error', (err) => {
    if (err?.code === 'EADDRINUSE') {
        console.error(`Port ${PORT} is already in use. Stop the existing process or set a different PORT.`);
        return;
    }
    console.error('Failed to start server:', err);
    process.exitCode = 1;
});

httpServer.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    if (fs.existsSync(adminIndex)) {
        console.log(`Admin panel:    http://localhost:${PORT}/admin`);
    } else {
        console.warn('Admin panel:    not built — run npm run build:admin (503 at /admin until then)');
    }
    if (process.env.ADMIN_BOOTSTRAP_EMAIL) {
        console.log(`Admin bootstrap email: ${process.env.ADMIN_BOOTSTRAP_EMAIL}`);
    }
});
