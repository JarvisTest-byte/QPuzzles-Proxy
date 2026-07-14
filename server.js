
const http = require('http');
const https = require('https');
const url = require('url');
const { Client } = require('pg');

const PORT = process.env.PORT || 3131;
const DATABASE_URL = process.env.DATABASE_URL;

let db;

async function connectDB() {
  db = new Client({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await db.connect();
  console.log('[db] Connected');
  await db.query(`CREATE TABLE IF NOT EXISTS shop_credentials (
    shop_domain TEXT PRIMARY KEY, client_id TEXT NOT NULL, client_secret TEXT NOT NULL,
    token TEXT, token_expires_at BIGINT DEFAULT 0, updated_at TIMESTAMP DEFAULT NOW())`);
  await db.query(`CREATE TABLE IF NOT EXISTS production_status (
    order_key TEXT PRIMARY KEY, status TEXT NOT NULL, updated_at TIMESTAMP DEFAULT NOW())`);
  await db.query(`CREATE TABLE IF NOT EXISTS manual_orders (
    id TEXT PRIMARY KEY, order_data JSONB NOT NULL, created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW())`);
  await db.query(`CREATE TABLE IF NOT EXISTS imported_orders (
    id TEXT PRIMARY KEY, source_label TEXT NOT NULL, order_data JSONB NOT NULL, created_at TIMESTAMP DEFAULT NOW())`);
  await db.query(`CREATE TABLE IF NOT EXISTS deleted_shopify_orders (
    order_id TEXT PRIMARY KEY, deleted_at TIMESTAMP DEFAULT NOW())`);
  console.log('[db] Tables ready');
}

function fetchFreshToken(shopDomain, clientId, clientSecret) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ client_id: clientId, client_secret: clientSecret, grant_type: 'client_credentials' });
    const req = https.request({
      hostname: shopDomain, path: '/admin/oauth/access_token', method: 'POST',
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
  const res = await db.query('SELECT * FROM shop_credentials WHERE shop_domain=$1', [shopDomain]);
  if (!res.rows.length) return null;
  const creds = res.rows[0];
  const now = Date.now();
  if (!creds.token || parseInt(creds.token_expires_at) - now < 5 * 60 * 1000) {
    console.log('[token] Refreshing for ' + shopDomain);
    const result = await fetchFreshToken(shopDomain, creds.client_id, creds.client_secret);
    const expiresAt = now + (result.expires_in || 86399) * 1000;
    await db.query('UPDATE shop_credentials SET token=$1, token_expires_at=$2, updated_at=NOW() WHERE shop_domain=$3',
      [result.access_token, expiresAt, shopDomain]);
    return result.access_token;
  }
  return creds.token;
}

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

const server = http.createServer(async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  const parsed = url.parse(req.url);
  const path = parsed.pathname;

  try {
    if (path === '/health') return sendJSON(res, 200, { status: 'ok', db: !!db });

    // Credentials
    if (path === '/register-credentials' && req.method === 'POST') {
      const { shopDomain, clientId, clientSecret } = await readBody(req);
      if (!shopDomain || !clientId || !clientSecret) return sendJSON(res, 400, { error: 'Missing fields' });
      await db.query(`INSERT INTO shop_credentials (shop_domain,client_id,client_secret) VALUES($1,$2,$3)
        ON CONFLICT(shop_domain) DO UPDATE SET client_id=$2,client_secret=$3,token=NULL,token_expires_at=0,updated_at=NOW()`,
        [shopDomain, clientId, clientSecret]);
      try { await getValidToken(shopDomain); return sendJSON(res, 200, { success: true }); }
      catch(e) { await db.query('DELETE FROM shop_credentials WHERE shop_domain=$1',[shopDomain]); return sendJSON(res, 401, { error: 'Invalid credentials: '+e.message }); }
    }

    // Production status - get all
    if (path === '/production-status' && req.method === 'GET') {
      const result = await db.query('SELECT order_key, status FROM production_status');
      const map = {};
      result.rows.forEach(r => { map[r.order_key] = r.status; });
      return sendJSON(res, 200, map);
    }

    // Production status - save one
    if (path === '/production-status' && req.method === 'POST') {
      const { orderKey, status } = await readBody(req);
      if (!orderKey || !status) return sendJSON(res, 400, { error: 'Missing orderKey or status' });
      await db.query(`INSERT INTO production_status(order_key,status) VALUES($1,$2)
        ON CONFLICT(order_key) DO UPDATE SET status=$2,updated_at=NOW()`, [orderKey, status]);
      return sendJSON(res, 200, { success: true });
    }

    // Manual orders - get all
    if (path === '/manual-orders' && req.method === 'GET') {
      const result = await db.query('SELECT order_data FROM manual_orders ORDER BY created_at ASC');
      return sendJSON(res, 200, result.rows.map(r => r.order_data));
    }

    // Manual orders - save one
    if (path === '/manual-orders' && req.method === 'POST') {
      const order = await readBody(req);
      if (!order.id) return sendJSON(res, 400, { error: 'Missing id' });
      await db.query(`INSERT INTO manual_orders(id,order_data) VALUES($1,$2)
        ON CONFLICT(id) DO UPDATE SET order_data=$2,updated_at=NOW()`, [order.id, JSON.stringify(order)]);
      return sendJSON(res, 200, { success: true });
    }

    // Manual orders - delete one
    if (path.startsWith('/manual-orders/') && req.method === 'DELETE') {
      const id = decodeURIComponent(path.replace('/manual-orders/', ''));
      await db.query('DELETE FROM manual_orders WHERE id=$1', [id]);
      await db.query('DELETE FROM production_status WHERE order_key=$1', ['manual_'+id]);
      return sendJSON(res, 200, { success: true });
    }

    // Imported orders - get all
    if (path === '/imported-orders' && req.method === 'GET') {
      const result = await db.query('SELECT order_data FROM imported_orders ORDER BY created_at ASC');
      return sendJSON(res, 200, result.rows.map(r => r.order_data));
    }

    // Imported orders - save batch
    if (path === '/imported-orders' && req.method === 'POST') {
      const orders = await readBody(req);
      if (!Array.isArray(orders)) return sendJSON(res, 400, { error: 'Expected array' });
      for (const order of orders) {
        await db.query(`INSERT INTO imported_orders(id,source_label,order_data) VALUES($1,$2,$3)
          ON CONFLICT(id) DO UPDATE SET order_data=$3`, [order.id, order.source||'imported', JSON.stringify(order)]);
      }
      return sendJSON(res, 200, { success: true, count: orders.length });
    }

    // Imported orders - delete one
    if (path.startsWith('/imported-orders/') && req.method === 'DELETE') {
      const id = decodeURIComponent(path.replace('/imported-orders/', ''));
      await db.query('DELETE FROM imported_orders WHERE id=$1', [id]);
      return sendJSON(res, 200, { success: true });
    }

    // Deleted Shopify orders - get list
    if (path === '/deleted-shopify-orders' && req.method === 'GET') {
      const result = await db.query('SELECT order_id FROM deleted_shopify_orders');
      return sendJSON(res, 200, result.rows.map(r => r.order_id));
    }

    // Deleted Shopify orders - mark deleted
    if (path === '/deleted-shopify-orders' && req.method === 'POST') {
      const { orderId } = await readBody(req);
      if (!orderId) return sendJSON(res, 400, { error: 'Missing orderId' });
      await db.query(`INSERT INTO deleted_shopify_orders(order_id) VALUES($1) ON CONFLICT DO NOTHING`, [orderId]);
      await db.query('DELETE FROM production_status WHERE order_key=$1', ['shopify_'+orderId]);
      return sendJSON(res, 200, { success: true });
    }

    // Shopify API proxy pass-through
    const shopDomain = req.headers['x-shop-domain'];
    if (!shopDomain) return sendJSON(res, 400, { error: 'Missing X-Shop-Domain' });
    let token;
    try {
      token = await getValidToken(shopDomain);
      if (!token) token = req.headers['x-shopify-access-token'];
    } catch(e) { return sendJSON(res, 502, { error: 'Token refresh failed: '+e.message }); }
    if (!token) return sendJSON(res, 401, { error: 'No token. Register credentials first.' });

    console.log('[proxy] ' + req.method + ' https://' + shopDomain + parsed.path);
    const proxyReq = https.request({
      method: req.method, hostname: shopDomain, path: parsed.path,
      headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' }
    }, (proxyRes) => {
      if (proxyRes.headers['link']) res.setHeader('Link', proxyRes.headers['link']);
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(proxyRes.statusCode);
      proxyRes.pipe(res);
    });
    proxyReq.on('error', e => { console.error(e.message); sendJSON(res, 502, { error: e.message }); });
    proxyReq.end();

  } catch(e) {
    console.error('[error]', e.message);
    sendJSON(res, 500, { error: e.message });
  }
});

connectDB().then(() => {
  server.listen(PORT, () => console.log('QPuzzles Proxy running on port ' + PORT));
}).catch(e => { console.error('DB connection failed:', e.message); process.exit(1); });
