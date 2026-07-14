const http = require('http');
const https = require('https');
const url = require('url');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3131;
const DATA_FILE = path.join('/tmp', 'qpuzzles-data.json');

// ── Simple JSON file storage ──────────────────────────────────
function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    }
  } catch(e) { console.error('Load error:', e.message); }
  return {
    credentials: {},
    tokens: {},
    productionStatus: {},
    manualOrders: {},
    importedOrders: {},
    deletedShopifyIds: []
  };
}

function saveData(data) {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2)); }
  catch(e) { console.error('Save error:', e.message); }
}

let store = loadData();
console.log('[db] Loaded data from file. Shops:', Object.keys(store.credentials));

// ── Token management ──────────────────────────────────────────
function fetchFreshToken(shopDomain, clientId, clientSecret) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'client_credentials'
    });
    const req = https.request({
      hostname: shopDomain,
      path: '/admin/oauth/access_token',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (res.statusCode === 200 && json.access_token) resolve(json);
          else reject(new Error('Token fetch failed (' + res.statusCode + '): ' + JSON.stringify(json)));
        } catch(e) { reject(new Error('Invalid JSON from Shopify')); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function getValidToken(shopDomain) {
  const creds = store.credentials[shopDomain];
  if (!creds) return null;
  const tokenInfo = store.tokens[shopDomain];
  const now = Date.now();
  if (!tokenInfo || tokenInfo.expiresAt - now < 5 * 60 * 1000) {
    console.log('[token] Refreshing for ' + shopDomain);
    const result = await fetchFreshToken(shopDomain, creds.clientId, creds.clientSecret);
    store.tokens[shopDomain] = {
      token: result.access_token,
      expiresAt: now + (result.expires_in || 86399) * 1000
    };
    saveData(store);
    console.log('[token] Refreshed for ' + shopDomain);
    return result.access_token;
  }
  return tokenInfo.token;
}

// ── HTTP helpers ──────────────────────────────────────────────
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Shop-Domain, X-Shopify-Access-Token');
}

function sendJSON(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch(e) { reject(e); } });
  });
}

// ── Server ────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  const parsed = url.parse(req.url);
  const p = parsed.pathname;

  try {
    // Health check
    if (p === '/health') {
      return sendJSON(res, 200, { status: 'ok', shops: Object.keys(store.credentials) });
    }

    // Register credentials
    if (p === '/register-credentials' && req.method === 'POST') {
      const { shopDomain, clientId, clientSecret } = await readBody(req);
      if (!shopDomain || !clientId || !clientSecret)
        return sendJSON(res, 400, { error: 'Missing fields' });
      store.credentials[shopDomain] = { clientId, clientSecret };
      delete store.tokens[shopDomain];
      saveData(store);
      try {
        await getValidToken(shopDomain);
        return sendJSON(res, 200, { success: true });
      } catch(e) {
        delete store.credentials[shopDomain];
        saveData(store);
        return sendJSON(res, 401, { error: 'Invalid credentials: ' + e.message });
      }
    }

    // Production status - get all
    if (p === '/production-status' && req.method === 'GET') {
      return sendJSON(res, 200, store.productionStatus || {});
    }

    // Production status - save one
    if (p === '/production-status' && req.method === 'POST') {
      const { orderKey, status } = await readBody(req);
      if (!orderKey || !status) return sendJSON(res, 400, { error: 'Missing fields' });
      store.productionStatus[orderKey] = status;
      saveData(store);
      return sendJSON(res, 200, { success: true });
    }

    // Manual orders - get all
    if (p === '/manual-orders' && req.method === 'GET') {
      return sendJSON(res, 200, Object.values(store.manualOrders || {}));
    }

    // Manual orders - save one
    if (p === '/manual-orders' && req.method === 'POST') {
      const order = await readBody(req);
      if (!order.id) return sendJSON(res, 400, { error: 'Missing id' });
      store.manualOrders[order.id] = order;
      saveData(store);
      return sendJSON(res, 200, { success: true });
    }

    // Manual orders - delete one
    if (p.startsWith('/manual-orders/') && req.method === 'DELETE') {
      const id = decodeURIComponent(p.replace('/manual-orders/', ''));
      delete store.manualOrders[id];
      delete store.productionStatus['manual_' + id];
      saveData(store);
      return sendJSON(res, 200, { success: true });
    }

    // Imported orders - get all
    if (p === '/imported-orders' && req.method === 'GET') {
      return sendJSON(res, 200, Object.values(store.importedOrders || {}));
    }

    // Imported orders - save batch
    if (p === '/imported-orders' && req.method === 'POST') {
      const orders = await readBody(req);
      if (!Array.isArray(orders)) return sendJSON(res, 400, { error: 'Expected array' });
      orders.forEach(o => { store.importedOrders[o.id] = o; });
      saveData(store);
      return sendJSON(res, 200, { success: true, count: orders.length });
    }

    // Imported orders - delete one
    if (p.startsWith('/imported-orders/') && req.method === 'DELETE') {
      const id = decodeURIComponent(p.replace('/imported-orders/', ''));
      delete store.importedOrders[id];
      saveData(store);
      return sendJSON(res, 200, { success: true });
    }

    // Deleted Shopify orders - get list
    if (p === '/deleted-shopify-orders' && req.method === 'GET') {
      return sendJSON(res, 200, store.deletedShopifyIds || []);
    }

    // Deleted Shopify orders - mark deleted
    if (p === '/deleted-shopify-orders' && req.method === 'POST') {
      const { orderId } = await readBody(req);
      if (!orderId) return sendJSON(res, 400, { error: 'Missing orderId' });
      if (!store.deletedShopifyIds) store.deletedShopifyIds = [];
      if (!store.deletedShopifyIds.includes(String(orderId))) {
        store.deletedShopifyIds.push(String(orderId));
      }
      delete store.productionStatus['shopify_' + orderId];
      saveData(store);
      return sendJSON(res, 200, { success: true });
    }

    // Shopify API proxy
    const shopDomain = req.headers['x-shop-domain'];
    if (!shopDomain) return sendJSON(res, 400, { error: 'Missing X-Shop-Domain' });

    let token;
    try {
      token = await getValidToken(shopDomain);
      if (!token) token = req.headers['x-shopify-access-token'];
    } catch(e) {
      return sendJSON(res, 502, { error: 'Token refresh failed: ' + e.message });
    }
    if (!token) return sendJSON(res, 401, { error: 'No token. Register credentials first.' });

    console.log('[proxy] ' + req.method + ' https://' + shopDomain + parsed.path);
    const proxyReq = https.request({
      method: req.method,
      hostname: shopDomain,
      path: parsed.path,
      headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' }
    }, (proxyRes) => {
      if (proxyRes.headers['link']) res.setHeader('Link', proxyRes.headers['link']);
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(proxyRes.statusCode);
      proxyRes.pipe(res);
    });
    proxyReq.on('error', e => {
      console.error('[proxy] Error:', e.message);
      sendJSON(res, 502, { error: e.message });
    });
    proxyReq.end();

  } catch(e) {
    console.error('[error]', e.message);
    sendJSON(res, 500, { error: e.message });
  }
});

server.listen(PORT, () => {
  console.log('QPuzzles Proxy running on port ' + PORT);
  console.log('No database required - using file storage');
});
