const { AsyncLocalStorage } = require('async_hooks');
const jwt = require('jsonwebtoken');
const { logError } = require('../services/errorLogger');

const als = new AsyncLocalStorage();

// Capture les console.error d'une requête (les contrôleurs y écrivent leurs exceptions avec la stack)
const originalConsoleError = console.error;
console.error = (...args) => {
  const store = als.getStore();
  if (store && store.erreurs.length < 5) store.erreurs.push(args);
  originalConsoleError.apply(console, args);
};

const STATUTS_WARNING = new Set([400, 403, 404, 409, 413, 422, 429]);
const IGNORER = ['/api/errors/report'];

function extraireErreur(erreurs) {
  for (const args of erreurs) {
    const err = args.find((a) => a instanceof Error);
    if (err) return { message: err.message, stack: err.stack, prefixe: args.find((a) => typeof a === 'string') };
  }
  const txt = erreurs.flat().filter((a) => typeof a === 'string').join(' ');
  return txt ? { message: txt, stack: null } : null;
}

function utilisateur(req) {
  if (req.user) return req.user;
  try {
    const t = (req.headers.authorization || '').split(' ')[1];
    return t ? jwt.verify(t, process.env.JWT_SECRET) : null;
  } catch { return null; }
}

/**
 * Journalise automatiquement toute réponse d'erreur (5xx = erreur, refus 4xx = avertissement).
 * L'écriture est attendue (max 1,5 s) AVANT l'envoi de la réponse, car en serverless (Vercel)
 * le traitement peut être gelé dès que la réponse est partie.
 */
function requestMonitor(req, res, next) {
  const store = { erreurs: [] };
  const jsonOriginal = res.json.bind(res);

  res.json = (body) => {
    const statut = res.statusCode;
    const ignorer = IGNORER.some((p) => req.originalUrl.startsWith(p));
    const aJournaliser = !ignorer && (statut >= 500 || STATUTS_WARNING.has(statut));
    if (!aJournaliser) return jsonOriginal(body);

    const detail = extraireErreur(store.erreurs);
    const message = (body && body.message) || detail?.message || `HTTP ${statut}`;
    // Jetons expirés/manquants : comportement normal, on ne pollue pas le journal
    if (statut === 403 && /^Token /.test(message)) return jsonOriginal(body);
    const route = req.route ? `${req.baseUrl || ''}${req.route.path}` : req.originalUrl.split('?')[0];
    const contexte = {
      url: req.originalUrl.split('?')[0],
      params: req.params,
      detail_serveur: detail && detail.message !== message ? detail.message : undefined,
      detail_reponse: body && body.detail ? body.detail : undefined,
    };
    const enregistrement = logError({
      source: 'backend',
      niveau: statut >= 500 ? 'error' : 'warning',
      message, stack: detail?.stack, route, methode: req.method, statut,
      user: utilisateur(req), userAgent: req.headers['user-agent'], contexte,
    });
    const delai = new Promise((r) => setTimeout(r, 1500));
    Promise.race([enregistrement, delai]).finally(() => jsonOriginal(body));
    return res;
  };

  als.run(store, next);
}

module.exports = { requestMonitor };
