/**
 * DUPR API Proxy — Serveur Node.js local
 * À placer dans votre repo GitHub : PickleTM94/PickleTM/dupr-proxy-server.js
 *
 * Lancement : node dupr-proxy-server.js
 * Écoute sur : http://localhost:3001
 *
 * En production Electron, ce serveur peut être intégré directement
 * dans le process main d'Electron (voir commentaire en bas de fichier).
 *
 * Aucune dépendance npm requise — utilise uniquement les modules natifs Node.js
 */

const http  = require('http');
const https = require('https');

// ── Configuration ──
const PORT = 3001;

// UAT : utiliser ces clés pour les tests
// Production : remplacer par vos clés de production DUPR
const DUPR_CLIENT_KEY    = 'test-ck-589bf31d-f9ed-43c4-f96c-2386131476a0';
const DUPR_CLIENT_SECRET = 'test-cs-65b21222d6954d80facb3decbc8ea599';
const DUPR_BASE          = 'https://uat.mydupr.com/api'; // → 'https://mydupr.com/api' en prod

const CREDS_B64 = Buffer.from(`${DUPR_CLIENT_KEY}:${DUPR_CLIENT_SECRET}`).toString('base64');

// ── Cache du token partenaire ──
let _token       = null;
let _tokenExpiry = 0;

async function getPartnerToken() {
  if (_token && Date.now() < _tokenExpiry - 60_000) return _token;

  const data = await httpsRequest(`${DUPR_BASE}/v1.0/auth/login`, {
    method: 'POST',
    headers: {
      'x-authorization': CREDS_B64,
      'Content-Type': 'application/json',
    },
    body: '{}',
  });

  _token       = data.token || data.accessToken || data.access_token;
  _tokenExpiry = Date.now() + 55 * 60 * 1000; // 55 min
  console.log('[DUPR] Token partenaire obtenu ✓');
  return _token;
}

// ── Recherche de joueurs ──
async function searchPlayers(query, limit = 20, offset = 0) {
  const token = await getPartnerToken();
  const headers = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };

  // Tentative 1 : POST /v1.0/users/search
  try {
    const d = await httpsRequest(`${DUPR_BASE}/v1.0/users/search`, {
      method: 'POST', headers,
      body: JSON.stringify({ query, limit, offset }),
    });
    const players = d.players || d.results || d.data || (Array.isArray(d) ? d : null);
    if (players) return players;
  } catch(e) { console.warn('[DUPR] users/search échoué:', e.message); }

  // Tentative 2 : POST /v1.0/player/search
  const d = await httpsRequest(`${DUPR_BASE}/v1.0/player/search`, {
    method: 'POST', headers,
    body: JSON.stringify({ searchTerm: query, limit, offset }),
  });
  return d.players || d.results || d.data || (Array.isArray(d) ? d : []);
}

// ── Serveur HTTP ──
const server = http.createServer(async (req, res) => {
  // Headers CORS — autorise file:// (origin null) et localhost
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  // GET /health
  if (url.pathname === '/health') {
    res.writeHead(200);
    res.end(JSON.stringify({ status: 'ok', env: 'uat', port: PORT }));
    return;
  }

  // POST /search
  if (url.pathname === '/search' && req.method === 'POST') {
    try {
      const body  = await readBody(req);
      const { query, searchTerm, limit = 20, offset = 0 } = JSON.parse(body);
      const q = query || searchTerm || '';
      if (!q) { res.writeHead(400); res.end(JSON.stringify({ error: 'query requis' })); return; }

      console.log(`[DUPR] Recherche: "${q}"`);
      const players = await searchPlayers(q, limit, offset);
      console.log(`[DUPR] ${players.length} résultat(s)`);
      res.writeHead(200);
      res.end(JSON.stringify({ players, total: players.length }));
    } catch(e) {
      console.error('[DUPR] Erreur recherche:', e.message);
      res.writeHead(502);
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // GET /player/:duprId
  const m = url.pathname.match(/^\/player\/(\d+)$/);
  if (m) {
    try {
      const token = await getPartnerToken();
      const data  = await httpsRequest(`${DUPR_BASE}/v1.0/player/${m[1]}`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      res.writeHead(200);
      res.end(JSON.stringify(data));
    } catch(e) {
      res.writeHead(502);
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Route inconnue', path: url.pathname }));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`✅ DUPR Proxy démarré sur http://localhost:${PORT}`);
  console.log(`   Environnement : UAT`);
  console.log(`   Base DUPR    : ${DUPR_BASE}`);
  console.log(`   Test santé   : http://localhost:${PORT}/health`);
});

// ── Utilitaire : requête HTTPS avec promesse ──
function httpsRequest(urlStr, opts = {}) {
  return new Promise((resolve, reject) => {
    const u   = new URL(urlStr);
    const options = {
      hostname: u.hostname,
      path:     u.pathname + u.search,
      method:   opts.method || 'GET',
      headers:  opts.headers || {},
    };
    const req = https.request(options, res => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}: ${raw.slice(0, 200)}`));
        } else {
          try { resolve(JSON.parse(raw)); }
          catch(e) { reject(new Error(`JSON invalide: ${raw.slice(0, 100)}`)); }
        }
      });
    });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end',  () => resolve(body));
    req.on('error', reject);
  });
}

/*
 * ── Intégration Electron (optionnel) ──
 * Dans votre main.js Electron, ajoutez simplement :
 *
 *   require('./dupr-proxy-server.js');
 *
 * Le serveur proxy démarrera automatiquement avec l'app,
 * sans fenêtre ni process séparé à gérer.
 */
