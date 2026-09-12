const db = require('../config/db');

const PRIX_KG = 2500;
const F = n => `${parseInt(n || 0).toLocaleString('fr-FR')} F`;
const KG = n => `${parseFloat(n || 0).toFixed(1)} kg`;
const today = () => new Date().toISOString().split('T')[0];
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ─── Collecte des données ────────────────────────────────────
async function collecterDonnees(dateDebut, dateFin) {
  const [stockAvant, stockAjoute, ventes, mouvements, encaissements, pertes] = await Promise.all([
    // Kg restant en stock à la fin de la veille du jour de début choisi
    db.query(`
      SELECT GREATEST(0,
        COALESCE((SELECT SUM(quantite_kg) FROM stocks WHERE date_depot < $1::date), 0)
        - COALESCE((SELECT SUM(cv.kg_achetes) FROM ventes_journees vj JOIN clients_vente cv ON cv.journee_id = vj.id WHERE vj.date_vente < $1::date), 0)
        - COALESCE((SELECT SUM(kg_perdus) FROM pertes_stock WHERE date_perte < $1::date), 0)
      ) AS kg`, [dateDebut]),
    // Kg ajoutés du jour de début jusqu'à la fin du jour de fin (inclus)
    db.query(`SELECT COALESCE(SUM(quantite_kg),0) AS kg FROM stocks WHERE date_depot BETWEEN $1::date AND $2::date`, [dateDebut, dateFin]),
    db.query(`
      SELECT vj.date_vente::text AS date, cv.client_nom, u.nom || ' ' || u.prenom AS employe,
             cv.kg_achetes, cv.montant_recu, cv.commentaire, cv.reste_annule, cv.numero_client
      FROM clients_vente cv
      JOIN ventes_journees vj ON vj.id = cv.journee_id
      JOIN users u ON u.id = vj.employe_id
      WHERE vj.date_vente BETWEEN $1::date AND $2::date
      ORDER BY vj.date_vente, u.nom, cv.numero_client`, [dateDebut, dateFin]),
    db.query(`
      SELECT date_mouvement::text AS date, type, montant, commentaire,
             (SELECT nom || ' ' || prenom FROM users WHERE id = employe_id) AS employe
      FROM mouvements_caisse
      WHERE statut = 'approuvee' AND date_mouvement BETWEEN $1::date AND $2::date
      ORDER BY date_mouvement`, [dateDebut, dateFin]),
    db.query(`
      SELECT date_encaissement::text AS date, montant, commentaire,
             (SELECT nom || ' ' || prenom FROM users WHERE id = employe_id) AS employe
      FROM encaissements
      WHERE statut = 'approuvee' AND date_encaissement BETWEEN $1::date AND $2::date
      ORDER BY date_encaissement`, [dateDebut, dateFin]),
    db.query(`
      SELECT COALESCE(SUM(kg_perdus),0) AS kg
      FROM pertes_stock WHERE date_perte BETWEEN $1::date AND $2::date`, [dateDebut, dateFin]),
  ]);

  const kgStockTotal = parseFloat(stockAvant.rows[0].kg) + parseFloat(stockAjoute.rows[0].kg);

  const parJour = {};
  for (const v of ventes.rows) (parJour[v.date] ||= []).push(v);

  let totalKgVendu = 0, totalEncaisse = 0, totalReste = 0;
  for (const v of ventes.rows) {
    totalKgVendu += parseFloat(v.kg_achetes);
    totalEncaisse += parseFloat(v.montant_recu);
    if (!v.reste_annule) totalReste += Math.max(0, parseFloat(v.kg_achetes) * PRIX_KG - parseFloat(v.montant_recu));
  }

  const totalAjouts = mouvements.rows.filter(m => m.type === 'ajout').reduce((s, m) => s + parseFloat(m.montant), 0);
  const totalRetraits = mouvements.rows.filter(m => m.type === 'retrait').reduce((s, m) => s + parseFloat(m.montant), 0);
  const totalVerse = encaissements.rows.reduce((s, e) => s + parseFloat(e.montant), 0);
  const caisseTotale = totalEncaisse + totalAjouts;

  return {
    stock: { kgAvant: parseFloat(stockAvant.rows[0].kg), kgAjoute: parseFloat(stockAjoute.rows[0].kg), kgTotal: kgStockTotal, valeur: kgStockTotal * PRIX_KG },
    parJour,
    totaux: { kgVendu: totalKgVendu, encaisse: totalEncaisse, reste: totalReste },
    mouvements: mouvements.rows,
    encaissements: encaissements.rows,
    totalAjouts, totalRetraits, totalVerse,
    totalSorties: totalRetraits + totalVerse,
    pertes: { kg: parseFloat(pertes.rows[0].kg), valeur: parseFloat(pertes.rows[0].kg) * PRIX_KG },
    caisseTotale,
    caisseRestante: caisseTotale - totalRetraits - totalVerse,
  };
}

// ─── Construction du HTML ────────────────────────────────────
function construireHTML(d, dateDebut, dateFin) {
  const jours = Object.keys(d.parJour).sort();

  const tableauJour = (jour) => {
    const lignes = d.parJour[jour];
    let jourKg = 0, jourRecu = 0, jourReste = 0;
    const rows = lignes.map(v => {
      const reste = v.reste_annule ? 0 : Math.max(0, parseFloat(v.kg_achetes) * PRIX_KG - parseFloat(v.montant_recu));
      jourKg += parseFloat(v.kg_achetes); jourRecu += parseFloat(v.montant_recu); jourReste += reste;
      return `<tr>
        <td class="nom">${esc(v.client_nom || 'INCONNU')}</td>
        <td>${esc(v.employe)}</td>
        <td class="num">${KG(v.kg_achetes)}</td>
        <td class="num">${F(v.montant_recu)}</td>
        <td class="num ${reste > 0 ? 'red' : 'green'}">${v.reste_annule ? '✓ Annulé' : F(reste)}</td>
        <td class="com">${esc(v.commentaire) || '—'}</td>
      </tr>`;
    }).join('');
    return `
      <div class="jour-bloc">
        <div class="jour-titre">🗓️ ${esc(jour)}</div>
        <table>
          <thead><tr><th>Client</th><th>Employé</th><th class="num">Kg</th><th class="num">Reçu</th><th class="num">Reste</th><th>Commentaire</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
        <div class="jour-total">
          Total du jour&nbsp; • &nbsp;<b>${KG(jourKg)}</b> &nbsp; • &nbsp;Encaissé <b>${F(jourRecu)}</b> &nbsp; • &nbsp;Reste <b>${F(jourReste)}</b>
        </div>
      </div>`;
  };

  const mouvementsTries = [
    ...d.mouvements.map(m => ({ date: m.date, type: m.type === 'ajout' ? '➕ Entrée' : '➖ Sortie', classe: m.type === 'ajout' ? 'green' : 'red', montant: m.montant, commentaire: m.commentaire, employe: m.employe })),
    ...d.encaissements.map(e => ({ date: e.date, type: '💸 Versement patron', classe: 'red', montant: e.montant, commentaire: e.commentaire, employe: e.employe })),
  ].sort((a, b) => a.date.localeCompare(b.date));

  const ligneMouvement = m => `<tr>
      <td>${esc(m.date)}</td>
      <td>${m.type}</td>
      <td>${esc(m.employe) || '—'}</td>
      <td class="num ${m.classe}">${F(m.montant)}</td>
      <td class="com">${esc(m.commentaire) || '—'}</td>
    </tr>`;

  const recap = [
    ['1', 'Kg restant avant la période', KG(d.stock.kgAvant)],
    ['2', 'Kg ajoutés pendant la période', KG(d.stock.kgAjoute)],
    ['3', 'Kg total en stock (déposé)', KG(d.stock.kgTotal)],
    ['4', 'Valeur du stock (à 2 500 F/kg)', F(d.stock.valeur)],
    ['5', 'Total kg vendu', KG(d.totaux.kgVendu)],
    ['6', 'Total encaissé', F(d.totaux.encaisse)],
    ['7', 'Total des restes (non perçu)', F(d.totaux.reste)],
    ['8', "Total des entrées de caisse (ajouts)", F(d.totalAjouts)],
    ['9', 'Total des retraits de caisse', F(d.totalRetraits)],
    ['10', 'Total versé au patron', F(d.totalVerse)],
    ['11', 'Total des sorties de caisse (retraits + versements)', F(d.totalSorties)],
    ['12', 'Caisse totale (ventes + ajouts)', F(d.caisseTotale)],
    ['13', 'Caisse restante (caisse totale − retraits)', F(d.caisseRestante)],
    ['14', 'Kg total perdu', KG(d.pertes.kg)],
    ['15', 'Valeur totale perdue', F(d.pertes.valeur)],
  ];

  return `<!DOCTYPE html>
  <html><head><meta charset="utf-8"><style>
    @page { size: A4; margin: 12mm; }
    @media print { .no-print { display: none !important; } }
    * { box-sizing: border-box; }
    body { font-family: 'DejaVu Sans', 'Segoe UI', Arial, sans-serif; color: #1e293b; margin: 0; font-size: 12px; }
    .page { padding: 0 34px 34px; }
    .header { background: linear-gradient(120deg, #0e7490, #0369a1); color: #fff; padding: 28px 34px; margin-bottom: 22px; }
    .header h1 { margin: 0 0 6px; font-size: 22px; }
    .header p { margin: 0; opacity: .9; font-size: 13px; }
    .section { margin-top: 22px; page-break-inside: avoid; }
    .section-title { background: #f0f9ff; color: #0369a1; font-weight: bold; font-size: 14px; padding: 8px 14px; border-radius: 8px; margin-bottom: 10px; border-left: 5px solid #0369a1; }
    .kv { display: flex; justify-content: space-between; padding: 5px 4px; border-bottom: 1px solid #f1f5f9; font-size: 12.5px; }
    .kv b { font-weight: 600; }
    .kv.total { background: #f8fafc; font-weight: bold; border-radius: 6px; padding: 8px; }
    .kv.green b { color: #15803d; } .kv.red b { color: #b91c1c; }
    .jour-bloc { margin-bottom: 16px; page-break-inside: avoid; }
    .jour-titre { font-weight: bold; color: #334155; margin-bottom: 4px; font-size: 13px; }
    table { width: 100%; border-collapse: collapse; font-size: 10.5px; }
    thead th { background: #e2e8f0; color: #475569; text-align: left; padding: 5px 6px; font-size: 9.5px; text-transform: uppercase; }
    tbody td { padding: 4px 6px; border-bottom: 1px solid #f1f5f9; }
    td.num { text-align: right; white-space: nowrap; }
    td.nom { font-weight: 600; }
    td.com { color: #64748b; font-style: italic; }
    .red { color: #b91c1c; } .green { color: #15803d; }
    .jour-total { background: #f8fafc; border-radius: 6px; padding: 6px 10px; margin-top: 4px; font-size: 11px; color: #334155; }
    .empty { color: #94a3b8; font-style: italic; padding: 10px 4px; }
    .recap-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 18px; }
    .recap-item { display: flex; justify-content: space-between; background: #f8fafc; border-left: 3px solid #0ea5e9; border-radius: 4px; padding: 6px 10px; font-size: 11px; }
    .recap-item .num { font-weight: bold; }
    .badge-fin { background: #fef2f2; border-left: 4px solid #b91c1c; border-radius: 6px; padding: 8px 12px; margin-top: 8px; font-weight: bold; color: #b91c1c; }
    .badge-caisse { background: #ecfdf5; border-left: 4px solid #15803d; border-radius: 6px; padding: 8px 12px; margin-top: 8px; font-weight: bold; color: #15803d; }
  </style></head>
  <body>
    <div class="header">
      <h1>🐟 Rapport de gestion — Poissonnerie</h1>
      <p>Période du ${esc(dateDebut)} au ${esc(dateFin)} &nbsp;•&nbsp; généré le ${esc(today())}</p>
    </div>
    <div class="page">

      <div class="section">
        <div class="section-title">📦 Stock de la période</div>
        <div class="kv"><span>Kg restant au début de la période</span><b>${KG(d.stock.kgAvant)}</b></div>
        <div class="kv"><span>Kg ajoutés pendant la période</span><b>${KG(d.stock.kgAjoute)}</b></div>
        <div class="kv total"><span>Kg total déposé (disponible)</span><b>${KG(d.stock.kgTotal)}</b></div>
        <div class="kv total"><span>Valeur du stock (2 500 F/kg)</span><b>${F(d.stock.valeur)}</b></div>
      </div>

      <div class="section">
        <div class="section-title">📊 Ventes détaillées par journée</div>
        ${jours.length ? jours.map(tableauJour).join('') : '<div class="empty">Aucune vente enregistrée sur cette période.</div>'}
      </div>

      <div class="section">
        <div class="section-title">🧮 Totaux de la période</div>
        <div class="kv"><span>Total kg vendu</span><b>${KG(d.totaux.kgVendu)}</b></div>
        <div class="kv green"><span>Total encaissé</span><b>${F(d.totaux.encaisse)}</b></div>
        <div class="kv red"><span>Total des restes</span><b>${F(d.totaux.reste)}</b></div>
        
      </div>

      <div class="section">
        <div class="section-title">💰 Mouvements de caisse (entrées / sorties)</div>
        ${mouvementsTries.length ? `<table>
          <thead><tr><th>Date</th><th>Type</th><th>Employé</th><th class="num">Montant</th><th>Commentaire</th></tr></thead>
          <tbody>${mouvementsTries.map(ligneMouvement).join('')}</tbody>
        </table>` : '<div class="empty">Aucun mouvement de caisse sur cette période.</div>'}
        <div class="badge-fin">🔻 Total des sorties de caisse (retraits + versements) : ${F(d.totalSorties)}</div>
      </div>

      <div class="section">
        <div class="section-title">📋 Récapitulatif final</div>
        <div class="recap-grid">
          ${recap.map(([n, label, val]) => `<div class="recap-item"><span>${n}. ${esc(label)}</span><span class="num">${val}</span></div>`).join('')}
        </div>
        <div class="badge-caisse">💼 Caisse totale (ventes + ajouts) : ${F(d.caisseTotale)}</div>
        <div class="badge-caisse">🏦 Caisse restante (caisse totale − (retraits+verser)) : ${F(d.caisseRestante)}</div>
      </div>

    </div>
    <div class="no-print" style="position:fixed;top:14px;right:14px;">
      <button onclick="window.print()" style="background:#0369a1;color:#fff;border:none;padding:10px 18px;border-radius:8px;font-weight:bold;font-size:13px;cursor:pointer;box-shadow:0 4px 10px rgba(0,0,0,.15);">🖨️ Imprimer / Enregistrer en PDF</button>
    </div>
  </body></html>`;
}

// ─── Endpoint ────────────────────────────────────────────────
const genererRapportPDF = async (req, res) => {
  const { date_debut, date_fin } = req.query;
  if (!date_debut || !date_fin) return res.status(400).json({ message: 'date_debut et date_fin requis.' });
  if (date_fin < date_debut) return res.status(400).json({ message: 'date_fin doit être ≥ date_debut.' });

  try {
    const d = await collecterDonnees(date_debut, date_fin);
    const html = construireHTML(d, date_debut, date_fin);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) {
    console.error('genererRapportPDF:', err);
    if (!res.headersSent) res.status(500).json({ message: err.message || 'Erreur lors de la génération du rapport.' });
  }
};

module.exports = { genererRapportPDF };
