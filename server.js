// server.js - Mira Backend (PostgreSQL version for Render)
require('dotenv').config();

const express = require('express');
const bcrypt = require('bcryptjs');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const nodemailer = require('nodemailer');
const { google } = require('googleapis');
const cron = require('node-cron');
const fs = require('fs');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;
const APP_URL = process.env.APP_URL || null;

// ==================== POSTGRESQL DATABASE ====================
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }, // Required for Render PostgreSQL
    max: 10,
    idleTimeoutMillis: 30000,
});

// Test connection and initialize tables
pool.connect(async (err, client, release) => {
    if (err) {
        console.error('❌ PostgreSQL connection error:', err.stack);
        process.exit(1);
    }
    console.log('✅ PostgreSQL connected');
    release();
    await initDB();
});

// Helper: convert ? placeholders to $1, $2, ...
function convertPlaceholders(sql, params) {
    let paramIndex = 1;
    return sql.replace(/\?/g, () => `$${paramIndex++}`);
}

// Wrappers that mimic sqlite3’s callback interface (for SELECT, UPDATE, DELETE)
function dbGet(sql, params, callback) {
    const transformedSql = convertPlaceholders(sql, params);
    pool.query(transformedSql, params)
        .then(res => callback(null, res.rows[0] || null))
        .catch(err => callback(err, null));
}

function dbAll(sql, params, callback) {
    const transformedSql = convertPlaceholders(sql, params);
    pool.query(transformedSql, params)
        .then(res => callback(null, res.rows))
        .catch(err => callback(err, null));
}

// dbRun is kept for UPDATE/DELETE that don't need the returned ID
function dbRun(sql, params, callback) {
    const transformedSql = convertPlaceholders(sql, params);
    pool.query(transformedSql, params)
        .then(res => callback(null, { lastID: null, changes: res.rowCount }))
        .catch(err => callback(err, null));
}

const db = { get: dbGet, all: dbAll, run: dbRun };

// ==================== TABLE INITIALIZATION ====================
async function initDB() {
    const createTables = `
        CREATE TABLE IF NOT EXISTS users (
            id SERIAL PRIMARY KEY,
            first_name TEXT NOT NULL,
            middle_name TEXT,
            last_name TEXT NOT NULL,
            email TEXT UNIQUE NOT NULL,
            phone TEXT NOT NULL,
            password TEXT NOT NULL,
            gender TEXT,
            date_of_birth DATE,
            is_admin INTEGER DEFAULT 0,
            account_type TEXT DEFAULT 'patient',
            facility_type TEXT,
            institution_name TEXT,
            institution_id INTEGER,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS password_resets (
            id SERIAL PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            token TEXT NOT NULL,
            expires_at TIMESTAMP NOT NULL,
            used BOOLEAN DEFAULT FALSE
        );

        CREATE TABLE IF NOT EXISTS medications (
            id SERIAL PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            dosage TEXT NOT NULL,
            frequency TEXT NOT NULL,
            schedule TEXT NOT NULL,
            start_date DATE NOT NULL,
            end_date DATE,
            notes TEXT,
            is_active BOOLEAN DEFAULT TRUE,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS medication_reminders (
            id SERIAL PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            medication_id INTEGER NOT NULL REFERENCES medications(id) ON DELETE CASCADE,
            reminder_time TIME NOT NULL,
            reminder_date DATE NOT NULL,
            status TEXT DEFAULT 'pending',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS medication_history (
            id SERIAL PRIMARY KEY,
            medication_id INTEGER NOT NULL REFERENCES medications(id) ON DELETE CASCADE,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            taken_at TIMESTAMP,
            scheduled_time TIMESTAMP NOT NULL,
            status TEXT NOT NULL,
            notes TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS support_tickets (
            id SERIAL PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            subject TEXT NOT NULL,
            message TEXT NOT NULL,
            priority TEXT DEFAULT 'medium',
            status TEXT DEFAULT 'open',
            reply TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS sync_history (
            id SERIAL PRIMARY KEY,
            sync_type TEXT,
            records_count INTEGER,
            status TEXT,
            details TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS profile_change_requests (
            id SERIAL PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            field_type TEXT NOT NULL,
            old_value TEXT,
            new_value TEXT NOT NULL,
            otp_code TEXT NOT NULL,
            expires_at TIMESTAMP NOT NULL,
            verified BOOLEAN DEFAULT FALSE,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    `;

    try {
        await pool.query(createTables);
        console.log('✅ PostgreSQL tables ready');

        // Create default admin if not exists
        const adminCheck = await pool.query('SELECT id FROM users WHERE is_admin = 1 LIMIT 1');
        if (adminCheck.rows.length === 0) {
            const hashed = await bcrypt.hash('Admin123!', 12);
            await pool.query(
                `INSERT INTO users (first_name, last_name, email, phone, password, is_admin, account_type)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                ['Admin', 'User', 'admin@mira.com', '+1234567890', hashed, 1, 'institution']
            );
            console.log('✅ Default admin created: admin@mira.com / Admin123!');
        }
    } catch (err) {
        console.error('❌ Database initialization error:', err);
        process.exit(1);
    }
}

// ==================== GOOGLE SHEETS (SECRET METHOD) ====================
const SPREADSHEET_ID = process.env.GOOGLE_SHEETS_ID || '';
const CREDENTIALS_FILE = process.env.GOOGLE_CREDENTIALS_FILE || 'google-credentials.json';

const SHEETS = {
    USERS: 'Users',
    MEDICATIONS: 'Medications',
    REMINDERS: 'MedicationReminders',
    HISTORY: 'MedicationHistory',
    TICKETS: 'SupportTickets',
    PROFILE_CHANGES: 'ProfileChangeRequests',
    SYNC_HISTORY: 'SyncHistory',
    MASTER: 'MasterTracker'
};

let sheets = null;

// Priority: use GOOGLE_CREDENTIALS_JSON secret if available; otherwise fallback to file
if (SPREADSHEET_ID && process.env.GOOGLE_CREDENTIALS_JSON) {
    try {
        const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
        const auth = new google.auth.GoogleAuth({
            credentials: {
                client_email: credentials.client_email,
                private_key: credentials.private_key,
            },
            scopes: ['https://www.googleapis.com/auth/spreadsheets'],
        });
        sheets = google.sheets({ version: 'v4', auth });
        console.log('✅ Google Sheets configured (from environment secret)');
    } catch (err) {
        console.warn('⚠️ Google Sheets setup from secret failed:', err.message);
    }
} else if (SPREADSHEET_ID && fs.existsSync(CREDENTIALS_FILE)) {
    try {
        const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_FILE));
        const auth = new google.auth.GoogleAuth({
            credentials: {
                client_email: credentials.client_email,
                private_key: credentials.private_key,
            },
            scopes: ['https://www.googleapis.com/auth/spreadsheets'],
        });
        sheets = google.sheets({ version: 'v4', auth });
        console.log('✅ Google Sheets configured (from service account file)');
    } catch (err) {
        console.warn('⚠️ Google Sheets setup from file failed:', err.message);
    }
} else {
    console.log('📊 Google Sheets not configured – sync disabled');
}

// Helper functions for sheets
async function ensureSheetExists(sheetName) {
    if (!sheets) return false;
    try {
        const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
        const existingSheets = spreadsheet.data.sheets.map(s => s.properties.title);
        if (existingSheets.includes(sheetName)) return true;
        await sheets.spreadsheets.batchUpdate({
            spreadsheetId: SPREADSHEET_ID,
            resource: {
                requests: [{
                    addSheet: {
                        properties: { title: sheetName }
                    }
                }]
            }
        });
        console.log(`📄 Created sheet: ${sheetName}`);
        return true;
    } catch (err) {
        console.error(`❌ Failed to create sheet ${sheetName}:`, err.message);
        return false;
    }
}

async function syncTable(sheetName, query, headers, mapRow, orderBy = '') {
    if (!sheets) return;
    const exists = await ensureSheetExists(sheetName);
    if (!exists) return;
    try {
        const rows = await new Promise((resolve, reject) => {
            db.all(query + (orderBy ? ` ORDER BY ${orderBy}` : ''), [], (err, rows) => err ? reject(err) : resolve(rows));
        });
        const values = rows.map(mapRow);
        await sheets.spreadsheets.values.clear({
            spreadsheetId: SPREADSHEET_ID,
            range: `${sheetName}!A1:ZZZ`,
        });
        if (values.length > 0) {
            await sheets.spreadsheets.values.update({
                spreadsheetId: SPREADSHEET_ID,
                range: `${sheetName}!A1`,
                valueInputOption: 'RAW',
                resource: { values: [headers, ...values] },
            });
        } else {
            await sheets.spreadsheets.values.update({
                spreadsheetId: SPREADSHEET_ID,
                range: `${sheetName}!A1`,
                valueInputOption: 'RAW',
                resource: { values: [headers] },
            });
        }
        console.log(`✅ Synced ${rows.length} records to sheet "${sheetName}"`);
    } catch (err) {
        console.error(`❌ Sync error for ${sheetName}:`, err.message);
    }
}

async function syncUsers() {
    await syncTable(
        SHEETS.USERS,
        'SELECT id, first_name, middle_name, last_name, email, phone, gender, date_of_birth, created_at, is_admin FROM users',
        ['User ID', 'First Name', 'Middle Name', 'Last Name', 'Email', 'Phone', 'Gender', 'Date of Birth', 'Created At', 'Is Admin'],
        row => [row.id, row.first_name, row.middle_name || '', row.last_name, row.email, row.phone, row.gender || '', row.date_of_birth || '', row.created_at, row.is_admin ? 'Yes' : 'No'],
        'id'
    );
}

async function syncMedications() {
    await syncTable(
        SHEETS.MEDICATIONS,
        `SELECT id, user_id, name, dosage, frequency, schedule, start_date, end_date, notes, is_active, created_at 
         FROM medications`,
        ['Medication ID', 'User ID', 'Name', 'Dosage', 'Frequency', 'Schedule (Times)', 'Start Date', 'End Date', 'Notes', 'Active', 'Created At'],
        row => {
            let schedule = row.schedule;
            try { schedule = JSON.parse(schedule).join(', '); } catch { /* keep as is */ }
            return [row.id, row.user_id, row.name, row.dosage, row.frequency, schedule, row.start_date, row.end_date || '', row.notes || '', row.is_active ? 'Yes' : 'No', row.created_at];
        },
        'id'
    );
}

async function syncReminders() {
    await syncTable(
        SHEETS.REMINDERS,
        'SELECT id, user_id, medication_id, reminder_time, reminder_date, status, created_at FROM medication_reminders',
        ['Reminder ID', 'User ID', 'Medication ID', 'Reminder Time', 'Reminder Date', 'Status', 'Created At'],
        row => [row.id, row.user_id, row.medication_id, row.reminder_time, row.reminder_date, row.status, row.created_at],
        'id'
    );
}

async function syncHistory() {
    await syncTable(
        SHEETS.HISTORY,
        `SELECT mh.id AS history_id, mh.user_id, mh.medication_id, m.name AS medication_name, mh.status, mh.taken_at, mh.scheduled_time, mh.created_at
         FROM medication_history mh
         JOIN medications m ON mh.medication_id = m.id`,
        ['History ID', 'User ID', 'Medication ID', 'Medication Name', 'Status', 'Taken At', 'Scheduled Time', 'Created At'],
        row => [row.history_id, row.user_id, row.medication_id, row.medication_name, row.status, row.taken_at || '', row.scheduled_time, row.created_at],
        'history_id'
    );
}

async function syncTickets() {
    await syncTable(
        SHEETS.TICKETS,
        'SELECT id, user_id, subject, message, priority, status, reply, created_at FROM support_tickets',
        ['Ticket ID', 'User ID', 'Subject', 'Message', 'Priority', 'Status', 'Reply', 'Created At'],
        row => [row.id, row.user_id, row.subject, row.message, row.priority, row.status, row.reply || '', row.created_at],
        'id'
    );
}

async function syncProfileChanges() {
    await syncTable(
        SHEETS.PROFILE_CHANGES,
        'SELECT id, user_id, field_type, new_value, verified, expires_at, created_at FROM profile_change_requests',
        ['Request ID', 'User ID', 'Field Type', 'New Value', 'Verified', 'Expires At', 'Created At'],
        row => [row.id, row.user_id, row.field_type, row.new_value, row.verified ? 'Yes' : 'No', row.expires_at, row.created_at],
        'id'
    );
}

async function syncSyncHistory() {
    await syncTable(
        SHEETS.SYNC_HISTORY,
        'SELECT id, sync_type, records_count, status, details, created_at FROM sync_history',
        ['Sync ID', 'Type', 'Records Count', 'Status', 'Details', 'Created At'],
        row => [row.id, row.sync_type || 'full', row.records_count || 0, row.status, row.details || '', row.created_at],
        'id'
    );
}

async function syncMasterTracker() {
    if (!sheets) return;
    const exists = await ensureSheetExists(SHEETS.MASTER);
    if (!exists) return;
    try {
        const rows = await new Promise((resolve, reject) => {
            db.all(`
                SELECT 
                    u.id AS user_id,
                    u.first_name,
                    u.last_name,
                    u.email,
                    u.phone,
                    (SELECT id FROM medications WHERE user_id = u.id AND is_active = true ORDER BY created_at DESC LIMIT 1) AS medication_id,
                    (SELECT name FROM medications WHERE user_id = u.id AND is_active = true ORDER BY created_at DESC LIMIT 1) AS med_name,
                    (SELECT dosage FROM medications WHERE user_id = u.id AND is_active = true ORDER BY created_at DESC LIMIT 1) AS med_dosage,
                    (SELECT frequency FROM medications WHERE user_id = u.id AND is_active = true ORDER BY created_at DESC LIMIT 1) AS med_frequency,
                    (SELECT schedule FROM medications WHERE user_id = u.id AND is_active = true ORDER BY created_at DESC LIMIT 1) AS med_schedule,
                    (SELECT start_date FROM medications WHERE user_id = u.id AND is_active = true ORDER BY created_at DESC LIMIT 1) AS start_date,
                    (SELECT end_date FROM medications WHERE user_id = u.id AND is_active = true ORDER BY created_at DESC LIMIT 1) AS end_date,
                    (SELECT notes FROM medications WHERE user_id = u.id AND is_active = true ORDER BY created_at DESC LIMIT 1) AS med_notes,
                    (SELECT id FROM medication_reminders WHERE user_id = u.id AND status = 'pending' ORDER BY reminder_date, reminder_time LIMIT 1) AS reminder_id,
                    (SELECT id FROM medication_history WHERE user_id = u.id ORDER BY scheduled_time DESC LIMIT 1) AS history_id,
                    (SELECT id FROM support_tickets WHERE user_id = u.id ORDER BY created_at DESC LIMIT 1) AS ticket_id,
                    (SELECT id FROM profile_change_requests WHERE user_id = u.id ORDER BY created_at DESC LIMIT 1) AS request_id,
                    (SELECT id FROM sync_history ORDER BY created_at DESC LIMIT 1) AS sync_id
                FROM users u
                ORDER BY u.id
            `, [], (err, rows) => err ? reject(err) : resolve(rows));
        });
        const headers = [
            'User ID', 'Medication ID', 'Reminder ID', 'History ID', 'Ticket ID', 'Request ID', 'Sync ID',
            'First Name', 'Last Name', 'Email', 'Phone',
            'Medication Name', 'Dosage', 'Frequency', 'Schedule (Times)',
            'Start Date', 'End Date', 'Notes'
        ];
        const values = rows.map(r => {
            let schedule = r.med_schedule;
            try { schedule = JSON.parse(schedule).join(', '); } catch { schedule = r.med_schedule || ''; }
            return [
                r.user_id,
                r.medication_id || '',
                r.reminder_id || '',
                r.history_id || '',
                r.ticket_id || '',
                r.request_id || '',
                r.sync_id || '',
                r.first_name,
                r.last_name,
                r.email,
                r.phone,
                r.med_name || '',
                r.med_dosage || '',
                r.med_frequency || '',
                schedule,
                r.start_date || '',
                r.end_date || '',
                r.med_notes || ''
            ];
        });
        await sheets.spreadsheets.values.clear({
            spreadsheetId: SPREADSHEET_ID,
            range: `${SHEETS.MASTER}!A1:R${rows.length + 2}`,
        });
        await sheets.spreadsheets.values.update({
            spreadsheetId: SPREADSHEET_ID,
            range: `${SHEETS.MASTER}!A1`,
            valueInputOption: 'RAW',
            resource: { values: [headers, ...values] },
        });
        console.log(`✅ Synced ${rows.length} master tracker records to sheet "${SHEETS.MASTER}"`);
    } catch (err) {
        console.error('❌ Master tracker sync error:', err.message);
    }
}

async function fullSync() {
    await syncUsers();
    await syncMedications();
    await syncReminders();
    await syncHistory();
    await syncTickets();
    await syncProfileChanges();
    await syncSyncHistory();
    await syncMasterTracker();
}

cron.schedule('*/30 * * * *', fullSync);
app.post('/api/sync-sheets', async (req, res) => {
    await fullSync();
    res.json({ success: true });
});

// ==================== EMAIL ====================
let transporter = null;
if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
    transporter = nodemailer.createTransport({
        service: 'gmail',
        host: 'smtp.gmail.com',
        port: 587,
        secure: false,
        auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
        tls: { rejectUnauthorized: true }
    });
    transporter.verify((error) => {
        if (error) console.warn('⚠️ Email not configured:', error.message);
        else console.log('✅ Email ready');
    });
} else {
    console.log('📧 Email not configured – email features disabled');
}

async function sendEmail(to, subject, text, html) {
    if (!transporter) {
        console.log(`[EMAIL DISABLED] Would send to ${to}: ${subject}`);
        return { success: false };
    }
    try {
        const info = await transporter.sendMail({
            from: `"Mira Reminder" <${process.env.EMAIL_USER}>`,
            to, subject, text, html
        });
        console.log('✅ Email sent:', info.messageId);
        return { success: true };
    } catch (error) {
        console.error('❌ Email error:', error);
        return { success: false };
    }
}

// ==================== MIDDLEWARE ====================
app.use(cors({ origin: '*', credentials: true }));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(__dirname));

async function isAdmin(req, res, next) {
    const userId = req.headers['x-user-id'];
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });
    try {
        const user = await new Promise((resolve, reject) => {
            db.get('SELECT is_admin FROM users WHERE id = ?', [userId], (err, row) => err ? reject(err) : resolve(row));
        });
        if (user && user.is_admin === 1) {
            next();
        } else {
            res.status(403).json({ success: false, message: 'Forbidden: Admin access required' });
        }
    } catch {
        res.status(500).json({ success: false, message: 'Server error' });
    }
}

const authLimiter = rateLimit({
    windowMs: 30 * 1000,
    max: 5,
    message: { success: false, message: 'Too many attempts, try again later' },
    skipSuccessfulRequests: true
});
app.use('/api/login', authLimiter);
app.use('/api/register', authLimiter);
app.use('/api/forgot-password', authLimiter);
app.use('/api/send-otp', authLimiter);
app.use('/api/send-delete-otp', authLimiter);
app.use('/api/confirm-delete-account', authLimiter);
app.use('/api/admin/login', authLimiter);

// ==================== AUTHENTICATION (user) ====================
app.post('/api/register', async (req, res) => {
    const { firstName, middleName, lastName, email, phone, password, gender, dateOfBirth, isInstitution, institutionName, facilityType } = req.body;
    if (!firstName || !lastName || !email || !phone || !password) {
        return res.status(400).json({ success: false, message: 'All fields except middle name are required' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ success: false, message: 'Invalid email address' });
    }
    if (password.length < 8) {
        return res.status(400).json({ success: false, message: 'Password must be at least 8 characters' });
    }
    try {
        const existing = await new Promise((resolve, reject) => {
            db.get('SELECT id FROM users WHERE email = ?', [email], (err, row) => err ? reject(err) : resolve(row));
        });
        if (existing) {
            return res.status(409).json({ success: false, message: 'Email already registered' });
        }
        const hash = await bcrypt.hash(password, 12);
        const acctType = isInstitution ? 'institution' : 'patient';
        const adminFlag = isInstitution ? 1 : 0;

        const query = `
            INSERT INTO users (first_name, middle_name, last_name, email, phone, password, gender, date_of_birth, is_admin, account_type, facility_type, institution_name)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
            RETURNING id
        `;
        const values = [firstName, middleName || '', lastName, email, phone, hash, gender || '', dateOfBirth || null, adminFlag, acctType, facilityType || null, institutionName || null];
        const result = await pool.query(query, values);
        const newUserId = result.rows[0].id;

        res.status(201).json({
            success: true,
            message: isInstitution ? 'Institution account created successfully!' : 'Account created successfully!',
            user: { id: newUserId, firstName, lastName, email, accountType: acctType }
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Registration failed' });
    }
});

app.post('/api/login', async (req, res) => {
    const { emailOrPhone, password } = req.body;
    if (!emailOrPhone || !password) {
        return res.status(400).json({ success: false, message: 'Email/phone and password required' });
    }
    try {
        const isEmail = emailOrPhone.includes('@');
        const user = await new Promise((resolve, reject) => {
            db.get(
                isEmail ? 'SELECT * FROM users WHERE email = ?' : 'SELECT * FROM users WHERE phone = ?',
                [emailOrPhone],
                (err, row) => err ? reject(err) : resolve(row)
            );
        });
        if (!user || !(await bcrypt.compare(password, user.password))) {
            return res.status(401).json({ success: false, message: 'Invalid credentials' });
        }
        res.json({
            success: true,
            message: 'Login successful!',
            user: {
                id: user.id,
                firstName: user.first_name,
                lastName: user.last_name,
                email: user.email,
                phone: user.phone,
                gender: user.gender,
                dateOfBirth: user.date_of_birth
            }
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Login failed' });
    }
});

// ==================== USER PROFILE ====================
app.get('/api/user/:userId', (req, res) => {
    const userId = req.params.userId;
    db.get('SELECT id, first_name, middle_name, last_name, email, phone, gender, date_of_birth, created_at FROM users WHERE id = ?', [userId], (err, user) => {
        if (err || !user) return res.status(404).json({ success: false, message: 'User not found' });
        res.json({ success: true, user });
    });
});

// ==================== OTP FLOW (all OTPs via email) ====================
app.post('/api/send-otp', async (req, res) => {
    const { userId, fieldType, newValue } = req.body;
    if (!userId || !fieldType || !newValue) {
        return res.status(400).json({ success: false, message: 'Missing fields' });
    }
    try {
        const user = await new Promise((resolve, reject) => {
            db.get('SELECT * FROM users WHERE id = ?', [userId], (err, row) => err ? reject(err) : resolve(row));
        });
        if (!user) return res.status(404).json({ success: false, message: 'User not found' });

        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

        const query = `
            INSERT INTO profile_change_requests (user_id, field_type, old_value, new_value, otp_code, expires_at)
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING id
        `;
        const values = [userId, fieldType, user[fieldType === 'email' ? 'email' : fieldType === 'phone' ? 'phone' : 'password'], newValue, otp, expiresAt];
        const result = await pool.query(query, values);
        const requestId = result.rows[0].id;

        const emailSent = await sendEmail(
            user.email,
            `Mira OTP: Change ${fieldType}`,
            `Your OTP is ${otp}. Valid for 10 minutes.`,
            `<h3>Your OTP: ${otp}</h3><p>Valid for 10 minutes.</p><p>If you did not request this change, please ignore this email.</p>`
        );

        if (!emailSent.success) {
            await pool.query('DELETE FROM profile_change_requests WHERE id = $1', [requestId]);
            return res.status(500).json({ success: false, message: 'Failed to send OTP email' });
        }

        res.json({ success: true, message: `OTP sent to your email`, requestId });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Failed to send OTP' });
    }
});

app.post('/api/verify-and-update', async (req, res) => {
    const { userId, requestId, otp } = req.body;
    if (!userId || !requestId || !otp) {
        return res.status(400).json({ success: false, message: 'Missing fields' });
    }
    try {
        const request = await new Promise((resolve, reject) => {
            db.get(
                `SELECT * FROM profile_change_requests WHERE id = ? AND user_id = ? AND verified = false AND expires_at > NOW()`,
                [requestId, userId],
                (err, row) => err ? reject(err) : resolve(row)
            );
        });
        if (!request) return res.status(400).json({ success: false, message: 'Invalid or expired OTP request' });
        if (request.otp_code !== otp) return res.status(400).json({ success: false, message: 'Invalid OTP' });

        let updateQuery = '';
        let params = [];
        if (request.field_type === 'email') {
            updateQuery = 'UPDATE users SET email = $1 WHERE id = $2';
            params = [request.new_value, userId];
        } else if (request.field_type === 'phone') {
            updateQuery = 'UPDATE users SET phone = $1 WHERE id = $2';
            params = [request.new_value, userId];
        } else if (request.field_type === 'password') {
            const hashed = await bcrypt.hash(request.new_value, 12);
            updateQuery = 'UPDATE users SET password = $1 WHERE id = $2';
            params = [hashed, userId];
        } else {
            return res.status(400).json({ success: false, message: 'Invalid field type' });
        }

        await pool.query(updateQuery, params);
        await pool.query('UPDATE profile_change_requests SET verified = true WHERE id = $1', [requestId]);

        const updatedUser = await new Promise((resolve, reject) => {
            db.get('SELECT id, first_name, last_name, email, phone FROM users WHERE id = ?', [userId], (err, row) => err ? reject(err) : resolve(row));
        });
        res.json({ success: true, message: `${request.field_type} updated successfully`, user: updatedUser });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Verification failed' });
    }
});

// ==================== ACCOUNT DELETION ====================
app.post('/api/send-delete-otp', async (req, res) => {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ success: false, message: 'User ID required' });

    try {
        const user = await new Promise((resolve, reject) => {
            db.get('SELECT * FROM users WHERE id = ?', [userId], (err, row) => err ? reject(err) : resolve(row));
        });
        if (!user) return res.status(404).json({ success: false, message: 'User not found' });

        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

        const query = `
            INSERT INTO profile_change_requests (user_id, field_type, old_value, new_value, otp_code, expires_at)
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING id
        `;
        const values = [userId, 'delete_account', user.email, 'DELETE', otp, expiresAt];
        const result = await pool.query(query, values);
        const requestId = result.rows[0].id;

        const emailSent = await sendEmail(
            user.email,
            'Account Deletion OTP - Mira',
            `Your OTP to delete your Mira account is: ${otp}. This code expires in 10 minutes.`,
            `<h3>Account Deletion OTP</h3><p>Your OTP is: <strong>${otp}</strong></p><p>Valid for 10 minutes.</p><p>If you did not request this, ignore this email.</p>`
        );

        if (!emailSent.success) {
            await pool.query('DELETE FROM profile_change_requests WHERE id = $1', [requestId]);
            return res.status(500).json({ success: false, message: 'Failed to send OTP email' });
        }

        res.json({ success: true, message: 'OTP sent to your email', requestId });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

app.post('/api/confirm-delete-account', async (req, res) => {
    const { userId, requestId, otp } = req.body;
    if (!userId || !requestId || !otp) {
        return res.status(400).json({ success: false, message: 'Missing required fields' });
    }

    try {
        const request = await new Promise((resolve, reject) => {
            db.get(
                `SELECT * FROM profile_change_requests WHERE id = ? AND user_id = ? AND field_type = 'delete_account' AND verified = false AND expires_at > NOW()`,
                [requestId, userId],
                (err, row) => err ? reject(err) : resolve(row)
            );
        });
        if (!request) return res.status(400).json({ success: false, message: 'Invalid or expired OTP request' });
        if (request.otp_code !== otp) return res.status(400).json({ success: false, message: 'Invalid OTP' });

        await pool.query('UPDATE profile_change_requests SET verified = true WHERE id = $1', [requestId]);

        // Delete all user data
        await pool.query('DELETE FROM medication_history WHERE user_id = $1', [userId]);
        await pool.query('DELETE FROM medication_reminders WHERE user_id = $1', [userId]);
        await pool.query('DELETE FROM medications WHERE user_id = $1', [userId]);
        await pool.query('DELETE FROM support_tickets WHERE user_id = $1', [userId]);
        await pool.query('DELETE FROM profile_change_requests WHERE user_id = $1', [userId]);
        await pool.query('DELETE FROM password_resets WHERE user_id = $1', [userId]);
        await pool.query('DELETE FROM users WHERE id = $1', [userId]);

        if (sheets) fullSync();

        res.json({ success: true, message: 'Account permanently deleted. You will be redirected to the home page.' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Deletion failed. Please try again later.' });
    }
});

// ==================== MEDICATION ENDPOINTS ====================
app.get('/api/medications/:userId', (req, res) => {
    db.all('SELECT * FROM medications WHERE user_id = ? AND is_active = true ORDER BY created_at DESC', [req.params.userId], (err, rows) => {
        if (err) return res.status(500).json({ success: false });
        const medications = rows.map(r => ({ ...r, schedule: JSON.parse(r.schedule || '[]') }));
        res.json({ success: true, medications });
    });
});

app.post('/api/medications', async (req, res) => {
    const { userId, name, dosage, frequency, schedule, startDate, endDate, notes } = req.body;
    if (!userId || !name || !dosage || !frequency || !schedule || !startDate) {
        return res.status(400).json({ success: false, message: 'Missing fields' });
    }
    const query = `
        INSERT INTO medications (user_id, name, dosage, frequency, schedule, start_date, end_date, notes)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING id
    `;
    const values = [userId, name, dosage, frequency, JSON.stringify(schedule), startDate, endDate || null, notes || ''];
    try {
        const result = await pool.query(query, values);
        if (sheets) fullSync();
        res.status(201).json({ success: true, medicationId: result.rows[0].id });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'DB error' });
    }
});

app.put('/api/medications/:medicationId', (req, res) => {
    const medId = req.params.medicationId;
    const { userId, name, dosage, frequency, schedule, startDate, endDate, notes } = req.body;
    db.run(
        `UPDATE medications SET name=$1, dosage=$2, frequency=$3, schedule=$4, start_date=$5, end_date=$6, notes=$7
         WHERE id=$8 AND user_id=$9`,
        [name, dosage, frequency, JSON.stringify(schedule), startDate, endDate || null, notes || '', medId, userId],
        function(err) {
            if (err) return res.status(500).json({ success: false, message: 'Update failed' });
            if (sheets) fullSync();
            res.json({ success: true });
        }
    );
});

app.delete('/api/medications/:medicationId', (req, res) => {
    const medId = req.params.medicationId;
    const { userId } = req.body;
    db.run('UPDATE medications SET is_active = false WHERE id = $1 AND user_id = $2', [medId, userId], function(err) {
        if (err) return res.status(500).json({ success: false, message: 'Delete failed' });
        if (sheets) fullSync();
        res.json({ success: true });
    });
});

// ==================== MEDICATION HISTORY ====================
app.post('/api/medication-history', (req, res) => {
    const { userId, medicationId, status } = req.body;
    if (!userId || !medicationId || !status) {
        return res.status(400).json({ success: false, message: 'Missing fields' });
    }
    const scheduledTime = new Date().toISOString().replace('T', ' ').substring(0, 19);
    const takenAt = status === 'taken' ? scheduledTime : null;
    db.run(
        `INSERT INTO medication_history (medication_id, user_id, taken_at, scheduled_time, status)
         VALUES ($1, $2, $3, $4, $5)`,
        [medicationId, userId, takenAt, scheduledTime, status],
        function(err) {
            if (err) return res.status(500).json({ success: false, message: 'DB error' });
            if (sheets) fullSync();
            res.json({ success: true });
        }
    );
});

app.get('/api/medication-history/:userId', (req, res) => {
    db.all(
        `SELECT mh.*, m.name as medication_name, m.dosage
         FROM medication_history mh
         JOIN medications m ON mh.medication_id = m.id
         WHERE mh.user_id = $1
         ORDER BY mh.scheduled_time DESC LIMIT 100`,
        [req.params.userId],
        (err, rows) => {
            if (err) return res.status(500).json({ success: false });
            res.json({ success: true, history: rows });
        }
    );
});

// ==================== SUPPORT TICKETS ====================
app.post('/api/support-ticket', async (req, res) => {
    const { userId, subject, message, priority } = req.body;
    if (!userId || !subject || !message) {
        return res.status(400).json({ success: false, message: 'Missing fields' });
    }
    const query = `
        INSERT INTO support_tickets (user_id, subject, message, priority)
        VALUES ($1, $2, $3, $4)
        RETURNING id
    `;
    const values = [userId, subject, message, priority || 'medium'];
    try {
        const result = await pool.query(query, values);
        if (sheets) fullSync();
        res.json({ success: true, ticketId: result.rows[0].id });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'DB error' });
    }
});

// ==================== PASSWORD RESET ====================
app.post('/api/forgot-password', async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ success: false, message: 'Email required' });
    try {
        const user = await new Promise((resolve, reject) => {
            db.get('SELECT id, email, first_name FROM users WHERE email = ?', [email], (err, row) => err ? reject(err) : resolve(row));
        });
        if (!user) {
            return res.json({ success: true, message: 'If an account exists, a reset link has been sent.' });
        }
        await pool.query('DELETE FROM password_resets WHERE user_id = $1', [user.id]);
        const rawToken = crypto.randomBytes(32).toString('hex');
        const hashedToken = await bcrypt.hash(rawToken, 10);
        const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
        await pool.query('INSERT INTO password_resets (user_id, token, expires_at) VALUES ($1, $2, $3)', [user.id, hashedToken, expiresAt]);

        let baseUrl = APP_URL;
        if (!baseUrl) {
            const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'http';
            const host = req.headers.host;
            baseUrl = `${protocol}://${host}`;
        }
        const resetUrl = `${baseUrl}/reset-password.html?token=${rawToken}&uid=${user.id}`;
        await sendEmail(
            user.email,
            'Reset your Mira password (15 min expiry)',
            `Click to reset: ${resetUrl}`,
            `<a href="${resetUrl}">Reset password</a> – this link expires in 15 minutes.`
        );
        res.json({ success: true, message: 'If an account exists, a reset link has been sent.' });
    } catch (err) {
        console.error(err);
        res.json({ success: true, message: 'If an account exists, a reset link has been sent.' });
    }
});

app.get('/api/reset-password/verify/:token', async (req, res) => {
    const { token } = req.params;
    const uid = req.query.uid;
    if (!token || !uid) return res.json({ success: false });
    try {
        const row = await new Promise((resolve, reject) => {
            db.get(
                `SELECT * FROM password_resets WHERE user_id = $1 AND used = false AND expires_at > NOW()`,
                [uid],
                (err, row) => err ? reject(err) : resolve(row)
            );
        });
        if (!row) return res.json({ success: false });
        const valid = await bcrypt.compare(token, row.token);
        res.json({ success: valid });
    } catch {
        res.json({ success: false });
    }
});

app.post('/api/reset-password/:token', async (req, res) => {
    const { token } = req.params;
    const { password, uid } = req.body;
    if (!password || password.length < 8) {
        return res.status(400).json({ success: false, message: 'Password must be at least 8 characters' });
    }
    if (!uid) return res.status(400).json({ success: false, message: 'Missing user ID' });
    try {
        const row = await new Promise((resolve, reject) => {
            db.get(
                `SELECT * FROM password_resets WHERE user_id = $1 AND used = false AND expires_at > NOW()`,
                [uid],
                (err, row) => err ? reject(err) : resolve(row)
            );
        });
        if (!row || !(await bcrypt.compare(token, row.token))) {
            return res.status(400).json({ success: false, message: 'Invalid or expired link' });
        }
        const hash = await bcrypt.hash(password, 12);
        await pool.query('UPDATE users SET password = $1 WHERE id = $2', [hash, uid]);
        await pool.query('UPDATE password_resets SET used = true WHERE id = $1', [row.id]);
        res.json({ success: true, message: 'Password reset successfully' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// ==================== ADMIN ENDPOINTS ====================
app.post('/api/admin/login', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ success: false, message: 'Email and password required' });
    try {
        const user = await new Promise((resolve, reject) => {
            db.get('SELECT * FROM users WHERE email = ?', [email], (err, row) => err ? reject(err) : resolve(row));
        });
        if (!user || !(await bcrypt.compare(password, user.password))) {
            return res.status(401).json({ success: false, message: 'Invalid credentials' });
        }
        if (user.is_admin !== 1) {
            return res.status(403).json({ success: false, message: 'Not an admin account' });
        }
        res.json({ success: true, user: { id: user.id, name: user.institution_name || `${user.first_name} ${user.last_name}`, email: user.email } });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

app.get('/api/admin/users', isAdmin, async (req, res) => {
    try {
        const users = await new Promise((resolve, reject) => {
            db.all('SELECT id, first_name, middle_name, last_name, email, phone, gender, date_of_birth, created_at, is_admin FROM users ORDER BY id', [], (err, rows) => err ? reject(err) : resolve(rows));
        });
        res.json({ success: true, users });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.delete('/api/admin/users/:userId', isAdmin, async (req, res) => {
    const userId = req.params.userId;
    try {
        await pool.query('DELETE FROM medication_history WHERE user_id = $1', [userId]);
        await pool.query('DELETE FROM medication_reminders WHERE user_id = $1', [userId]);
        await pool.query('DELETE FROM medications WHERE user_id = $1', [userId]);
        await pool.query('DELETE FROM support_tickets WHERE user_id = $1', [userId]);
        await pool.query('DELETE FROM profile_change_requests WHERE user_id = $1', [userId]);
        await pool.query('DELETE FROM password_resets WHERE user_id = $1', [userId]);
        await pool.query('DELETE FROM users WHERE id = $1', [userId]);
        if (sheets) fullSync();
        res.json({ success: true, message: 'User deleted successfully' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.get('/api/admin/medications', isAdmin, async (req, res) => {
    try {
        const meds = await new Promise((resolve, reject) => {
            db.all(`
                SELECT m.*, u.first_name, u.last_name, u.email 
                FROM medications m 
                JOIN users u ON m.user_id = u.id 
                WHERE m.is_active = true 
                ORDER BY m.created_at DESC
            `, [], (err, rows) => err ? reject(err) : resolve(rows));
        });
        res.json({ success: true, medications: meds });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// Admin prescribes medication for a patient
app.post('/api/admin/medications', isAdmin, async (req, res) => {
    const { userId, name, dosage, frequency, schedule, startDate, endDate, notes } = req.body;
    if (!userId || !name || !dosage || !frequency || !schedule || !startDate) {
        return res.status(400).json({ success: false, message: 'Missing fields' });
    }
    const query = `
        INSERT INTO medications (user_id, name, dosage, frequency, schedule, start_date, end_date, notes)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING id
    `;
    const values = [userId, name, dosage, frequency, JSON.stringify(schedule), startDate, endDate || null, notes || ''];
    try {
        const result = await pool.query(query, values);
        if (sheets) fullSync();
        res.status(201).json({ success: true, medicationId: result.rows[0].id });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'DB error' });
    }
});

app.get('/api/admin/history', isAdmin, async (req, res) => {
    try {
        const history = await new Promise((resolve, reject) => {
            db.all(`
                SELECT h.*, m.name as medication_name, u.first_name, u.last_name, u.email
                FROM medication_history h
                JOIN medications m ON h.medication_id = m.id
                JOIN users u ON h.user_id = u.id
                ORDER BY h.scheduled_time DESC LIMIT 200
            `, [], (err, rows) => err ? reject(err) : resolve(rows));
        });
        res.json({ success: true, history });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.get('/api/admin/tickets', isAdmin, async (req, res) => {
    try {
        const tickets = await new Promise((resolve, reject) => {
            db.all(`
                SELECT t.*, u.first_name, u.last_name, u.email 
                FROM support_tickets t
                JOIN users u ON t.user_id = u.id
                ORDER BY t.created_at DESC
            `, [], (err, rows) => err ? reject(err) : resolve(rows));
        });
        res.json({ success: true, tickets });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.post('/api/admin/tickets/:ticketId/reply', isAdmin, async (req, res) => {
    const ticketId = req.params.ticketId;
    const { reply, status } = req.body;
    if (!reply) return res.status(400).json({ success: false, message: 'Reply message required' });
    try {
        const ticket = await new Promise((resolve, reject) => {
            db.get('SELECT user_id, subject FROM support_tickets WHERE id = ?', [ticketId], (err, row) => err ? reject(err) : resolve(row));
        });
        if (!ticket) return res.status(404).json({ success: false, message: 'Ticket not found' });
        await pool.query('UPDATE support_tickets SET reply = $1, status = $2 WHERE id = $3', [reply, status || 'closed', ticketId]);
        const user = await new Promise((resolve, reject) => {
            db.get('SELECT email, first_name FROM users WHERE id = ?', [ticket.user_id], (err, row) => err ? reject(err) : resolve(row));
        });
        if (user) {
            await sendEmail(
                user.email,
                `Reply to your support ticket: ${ticket.subject}`,
                `Admin replied: ${reply}\n\nTicket status: ${status || 'closed'}`,
                `<p>Admin replied: ${reply}</p><p>Ticket status: ${status || 'closed'}</p>`
            );
        }
        res.json({ success: true, message: 'Reply sent and ticket updated' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.get('/api/admin/stats', isAdmin, async (req, res) => {
    try {
        const totalUsers = await new Promise((resolve, reject) => {
            db.get('SELECT COUNT(*) as count FROM users WHERE is_admin = 0', [], (err, row) => err ? reject(err) : resolve(row.count));
        });
        const totalMeds = await new Promise((resolve, reject) => {
            db.get('SELECT COUNT(*) as count FROM medications WHERE is_active = true', [], (err, row) => err ? reject(err) : resolve(row.count));
        });
        const totalTickets = await new Promise((resolve, reject) => {
            db.get('SELECT COUNT(*) as count FROM support_tickets', [], (err, row) => err ? reject(err) : resolve(row.count));
        });
        const openTickets = await new Promise((resolve, reject) => {
            db.get('SELECT COUNT(*) as count FROM support_tickets WHERE status = \'open\'', [], (err, row) => err ? reject(err) : resolve(row.count));
        });
        const totalHistory = await new Promise((resolve, reject) => {
            db.get('SELECT COUNT(*) as count FROM medication_history', [], (err, row) => err ? reject(err) : resolve(row.count));
        });
        const adherenceRate = await new Promise((resolve, reject) => {
            db.get('SELECT ROUND(100.0 * SUM(CASE WHEN status = \'taken\' THEN 1 ELSE 0 END) / MAX(COUNT(*),1)) as rate FROM medication_history', [], (err, row) => err ? reject(err) : resolve(row.rate || 0));
        });
        res.json({ success: true, stats: { totalUsers, totalMeds, totalTickets, openTickets, totalHistory, adherenceRate } });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.get('/api/admin/sync-history', isAdmin, async (req, res) => {
    try {
        const history = await new Promise((resolve, reject) => {
            db.all('SELECT * FROM sync_history ORDER BY created_at DESC LIMIT 50', [], (err, rows) => err ? reject(err) : resolve(rows));
        });
        res.json({ success: true, history });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.post('/api/admin/trigger-sync', isAdmin, async (req, res) => {
    try {
        if (sheets) await fullSync();
        else return res.status(400).json({ success: false, message: 'Google Sheets not configured' });
        res.json({ success: true, message: 'Sync triggered successfully' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// ==================== ADHERENCE REPORT ====================
app.get('/api/admin/adherence-report', isAdmin, async (req, res) => {
    try {
        const rows = await new Promise((resolve, reject) => {
            db.all(`
                SELECT u.id, u.first_name, u.last_name, u.email,
                    COUNT(mh.id) AS total_doses,
                    SUM(CASE WHEN mh.status='taken' THEN 1 ELSE 0 END) AS taken_doses,
                    SUM(CASE WHEN mh.status='missed' THEN 1 ELSE 0 END) AS missed_doses,
                    ROUND(100.0 * SUM(CASE WHEN mh.status='taken' THEN 1 ELSE 0 END) / MAX(COUNT(mh.id),1)) AS adherence_pct,
                    0 AS appt_attended,
                    0 AS appt_missed
                FROM users u
                LEFT JOIN medication_history mh ON mh.user_id = u.id
                WHERE u.is_admin = 0
                GROUP BY u.id
                ORDER BY adherence_pct ASC
            `, [], (err, rows) => err ? reject(err) : resolve(rows));
        });
        res.json({ success: true, report: rows });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ==================== STATIC FILES ====================
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/login.html', (req, res) => res.sendFile(path.join(__dirname, 'login.html')));
app.get('/register.html', (req, res) => res.sendFile(path.join(__dirname, 'register.html')));
app.get('/dashboard.html', (req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));
app.get('/forgot-password.html', (req, res) => res.sendFile(path.join(__dirname, 'forgot-password.html')));
app.get('/reset-password.html', (req, res) => res.sendFile(path.join(__dirname, 'reset-password.html')));
app.get('/profile.html', (req, res) => res.sendFile(path.join(__dirname, 'profile.html')));
app.get('/admin-login.html', (req, res) => res.sendFile(path.join(__dirname, 'admin-login.html')));
app.get('/admin-dashboard.html', (req, res) => res.sendFile(path.join(__dirname, 'admin-dashboard.html')));

app.get('/manifest.json', (req, res) => {
    res.sendFile(path.join(__dirname, 'manifest.json'));
});
app.get('/sw.js', (req, res) => {
    res.sendFile(path.join(__dirname, 'sw.js'));
});

// ==================== START SERVER ====================
async function start() {
    if (SPREADSHEET_ID && sheets) {
        console.log(`📊 Google Sheets active – will sync to: ${Object.values(SHEETS).join(', ')}`);
        await fullSync();
    } else {
        console.log('📊 Google Sheets not configured – sync disabled');
    }

    app.listen(PORT, '0.0.0.0', () => {
        console.log(`\n🚀 Mira server running on http://localhost:${PORT}`);
        console.log(`📧 Email: ${process.env.EMAIL_USER || 'not configured'}`);
        console.log(`👑 Admin login: admin@mira.com / Admin123!`);
        console.log(`🔗 Reset link base URL: ${APP_URL || 'auto-detected from request'}\n`);
    });
}

start();
