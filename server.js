const http = require('http');
const https = require('https');
const url = require('url');

const PORT = process.env.PORT || 3131;

// In-memory credential + token store
// { shopDomain: { clientId, clientSecret, token, expiresAt } }
const store = {};

function fetchFreshToken(shopDomain, clientId, clientSecret) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'client_credentials'
    });
    const options = {
      hostname: shopDomain,
      path: '/admin/oauth/access_token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (res.statusCode === 200 && json.access_token) {
            resolve(json);
          } else {
            reject(new Error('Token fetch failed (' + res.statusCode + '): ' + JSON.stringify(json)));
          }
        } catch (e) {
          reject(new Error('Token fetch failed: invalid JSON response'));
        }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function getValidToken(shopDomain) {
  const entry = store[shopDomain];
  if (!entry || !entry.clientId || !entry.clientSecret) return null;
  const now = Date.now();
  // Refresh if expiring within 5 minutes
  if (!entry.token || entry.expiresAt - now < 5 * 60 * 1000) {
    console.log('[token] Refreshing token for ' + shopDomain);
    const result = await fetchFreshToken(shopDomain, entry.clientId, entry.clientSecret);
    const expiresInMs = (result.expires_in || 86399) * 1000;
    entry.token = result.access_token;
    entry.expiresAt = now + expiresInMs;
    console.log('[token] Token refreshed for ' + shopDomain + ', expires ' + new Date(entry.expiresAt).toISOString());
  }
  return entry.token;
}

const server = http.createServer(async (req, res) => {
  // CORS headers - allow requests from any origin (GitHub Pages, local files, etc.)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Shopify-Access-Token, X-Shop-Domain');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const parsed = url.parse(req.url);

  // Health check endpoint
  if (parsed.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', shops: Object.keys(store) }));
    return;
  }

  // Register credentials endpoint
  if (parsed.pathname === '/register-credentials' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { shopDomain, clientId, clientSecret } = JSON.parse(body);
        if (!shopDomain || !clientId || !clientSecret) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing shopDomain, clientId, or clientSecret' }));
          return;
        }
        store[shopDomain] = { clientId, clientSecret, token: null, expiresAt: 0 };
        // Immediately fetch a token to validate credentials
        try {
          await getValidToken(shopDomain);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
        } catch (e) {
          delete store[shopDomain];
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid credentials: ' + e.message }));
        }
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Bad request: ' + e.message }));
      }
    });
    return;
  }

  // Credential status check
  if (parsed.pathname === '/credential-status' && req.method === 'GET') {
    const shopDomain = req.headers['x-shop-domain'];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ registered: !!(shopDomain && store[shopDomain]) }));
    return;
  }

  // All other requests: proxy to Shopify Admin API
  const shopDomain = req.headers['x-shop-domain'];
  if (!shopDomain) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing X-Shop-Domain header' }));
    return;
  }

  let shopToken;
  try {
    shopToken = await getValidToken(shopDomain);
    if (!shopToken) {
      shopToken = req.headers['x-shopify-access-token'];
    }
  } catch (e) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Token refresh failed: ' + e.message }));
    return;
  }

  if (!shopToken) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'No token available. Register credentials first.' }));
    return;
  }

  const shopPath = parsed.path || '/';
  console.log('[proxy] ' + req.method + ' https://' + shopDomain + shopPath);

  const options = {
    method: req.method,
    headers: {
      'X-Shopify-Access-Token': shopToken,
      'Content-Type': 'application/json'
    }
  };

  const proxyReq = https.request('https://' + shopDomain + shopPath, options, (proxyRes) => {
    if (proxyRes.headers['link']) res.setHeader('Link', proxyRes.headers['link']);
    res.setHeader('Content-Type', 'application/json');
    res.writeHead(proxyRes.statusCode);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (e) => {
    console.error('[proxy] Error:', e.message);
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  });

  proxyReq.end();
});

server.listen(PORT, () => {
  console.log('QPuzzles Shopify Proxy running on port ' + PORT);
  console.log('Health check: http://localhost:' + PORT + '/health');
});
