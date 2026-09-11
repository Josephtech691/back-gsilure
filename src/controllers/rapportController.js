const db = require('../config/db');
const PDFDocument = require('pdfkit');

const PRIX_KG = 2500;
const F = n => `${parseInt(n || 0).toLocaleString('fr-FR')} F`;
const KG = n => `${parseFloat(n || 0).toFixed(1)} kg`;

const COLORS = {
  header: '#0e7490',      // ocean-700
  headerText: '#ffffff',
  section: '#0369a1',     // water-700
  sectionBg: '#f0f9ff',
  green: '#15803d',
  red: '#b91c1c',
  amber: '#b45309',
  amberBg: '#fffbeb',
  slate: '#475569',
  slateLight: '#f8fafc',
  border: '#e2e8f0',
};

async function collecterDonnees(dateDebut, dateFin) {
  const [stockDepose, ventes, mouvements, encaissements, pertes] = await Promise.all([
    db.query(`
      SELECT COALESCE(SUM(quantite_kg),0) AS kg, COALESCE(SUM(quantite_kg*prix_par_kg),0) AS valeur
      FROM stocks WHERE date_depot BETWEEN $1::date AND $2::date`, [dateDebut, dateFin]),
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
      SELECT COALESCE(SUM(kg_perdus),0) AS kg, COALESCE(SUM(kg_perdus)*${PRIX_KG},0) AS valeur
      FROM pertes_stock WHERE date_perte BETWEEN $1::date AND $2::date`, [dateDebut, dateFin]),
  ]);

  // Regroupement des ventes par jour
  const parJour = {};
  for (const v of ventes.rows) {
    if (!parJour[v.date]) parJour[v.date] = [];
    parJour[v.date].push(v);
  }

  let totalKgVendu = 0, totalEncaisse = 0, totalReste = 0;
  for (const v of ventes.rows) {
    totalKgVendu += parseFloat(v.kg_achetes);
    totalEncaisse += parseFloat(v.montant_recu);
    if (!v.reste_annule) totalReste += Math.max(0, parseFloat(v.kg_achetes) * PRIX_KG - parseFloat(v.montant_recu));
  }

  const totalAjouts = mouvements.rows.filter(m => m.type === 'ajout').reduce((s, m) => s + parseFloat(m.montant), 0);
  const totalRetraits = mouvements.rows.filter(m => m.type === 'retrait').reduce((s, m) => s + parseFloat(m.montant), 0);
  const totalVerse = encaissements.rows.reduce((s, e) => s + parseFloat(e.montant), 0);

  return {
    stockDepose: { kg: parseFloat(stockDepose.rows[0].kg), valeur: parseFloat(stockDepose.rows[0].valeur) },
    parJour,
    totaux: { kgVendu: totalKgVendu, encaisse: totalEncaisse, reste: totalReste },
    mouvements: mouvements.rows,
    encaissements: encaissements.rows,
    totalAjouts, totalRetraits, totalVerse,
    totalSorties: totalRetraits + totalVerse,
    pertes: { kg: parseFloat(pertes.rows[0].kg), valeur: parseFloat(pertes.rows[0].valeur) },
    caisseTotale: totalEncaisse + totalAjouts,
  };
}

const genererRapportPDF = async (req, res) => {
  const { date_debut, date_fin } = req.query;
  if (!date_debut || !date_fin) return res.status(400).json({ message: 'date_debut et date_fin requis.' });
  if (date_fin < date_debut) return res.status(400).json({ message: 'date_fin doit être ≥ date_debut.' });

  try {
    const d = await collecterDonnees(date_debut, date_fin);

    const doc = new PDFDocument({ size: 'A4', margin: 40, bufferPages: true });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="rapport-${date_debut}-au-${date_fin}.pdf"`);
    doc.pipe(res);

    const pageWidth = doc.page.width - 80;

    // ── Bandeau d'en-tête ──
    doc.rect(0, 0, doc.page.width, 90).fill(COLORS.header);
    doc.fillColor(COLORS.headerText).fontSize(20).font('Helvetica-Bold')
      .text('🐟 Rapport de gestion — Poissonnerie', 40, 28);
    doc.fontSize(11).font('Helvetica')
      .text(`Période du ${date_debut} au ${date_fin}`, 40, 58);
    doc.y = 110;

    const sectionTitle = (emoji, titre) => {
      checkBreak(28);
      doc.moveDown(0.5);
      doc.rect(40, doc.y, pageWidth, 24).fill(COLORS.sectionBg);
      doc.fillColor(COLORS.section).fontSize(13).font('Helvetica-Bold')
        .text(`${emoji}  ${titre}`, 48, doc.y + 6);
      doc.moveDown(1.6);
    };

    const checkBreak = (space) => {
      if (doc.y + space > doc.page.height - 50) doc.addPage();
    };

    const ligneKV = (label, valeur, opts = {}) => {
      checkBreak(18);
      doc.fontSize(10).font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').fillColor(opts.color || '#1e293b');
      doc.text(label, 48, doc.y, { continued: true, width: pageWidth - 20 });
      doc.text(valeur, { align: 'right' });
      doc.moveDown(0.3);
    };

    // ── 1. Stock déposé ──
    sectionTitle('📦', 'Stock déposé pendant la période');
    ligneKV('Kg total déposé', KG(d.stockDepose.kg));
    ligneKV('Valeur du dépôt', F(d.stockDepose.valeur));

    // ── 2. Ventes détaillées par journée ──
    sectionTitle('📊', 'Ventes détaillées par journée');
    const joursTries = Object.keys(d.parJour).sort();
    if (joursTries.length === 0) {
      doc.fontSize(10).fillColor('#94a3b8').text('Aucune vente enregistrée sur cette période.', 48);
      doc.moveDown(0.5);
    }
    for (const jour of joursTries) {
      checkBreak(50);
      doc.fontSize(11).font('Helvetica-Bold').fillColor(COLORS.slate).text(`🗓️ ${jour}`, 48, doc.y);
      doc.moveDown(0.3);

      // en-têtes de colonnes
      const colX = { nom: 55, emp: 200, kg: 300, recu: 360, reste: 430, com: 490 };
      doc.fontSize(8).font('Helvetica-Bold').fillColor('#64748b');
      doc.text('Client', colX.nom, doc.y, { continued: false });
      doc.text('Employé', colX.emp, doc.y - 10);
      doc.text('Kg', colX.kg, doc.y - 10);
      doc.text('Reçu', colX.recu, doc.y - 10);
      doc.text('Reste', colX.reste, doc.y - 10);
      doc.text('Commentaire', colX.com, doc.y - 10);
      doc.moveDown(0.2);

      let jourKg = 0, jourRecu = 0, jourReste = 0;
      for (const v of d.parJour[jour]) {
        checkBreak(16);
        const reste = v.reste_annule ? 0 : Math.max(0, parseFloat(v.kg_achetes) * PRIX_KG - parseFloat(v.montant_recu));
        jourKg += parseFloat(v.kg_achetes); jourRecu += parseFloat(v.montant_recu); jourReste += reste;
        doc.fontSize(8.5).font('Helvetica').fillColor('#334155');
        doc.text(v.client_nom || 'INCONNU', colX.nom, doc.y);
        doc.text(v.employe, colX.emp, doc.y - 10, { width: 95 });
        doc.text(KG(v.kg_achetes), colX.kg, doc.y - 10);
        doc.text(F(v.montant_recu), colX.recu, doc.y - 10);
        doc.fillColor(reste > 0 ? COLORS.red : COLORS.green).text(v.reste_annule ? 'Annulé' : F(reste), colX.reste, doc.y - 10);
        doc.fillColor('#64748b').text(v.commentaire || '—', colX.com, doc.y - 10, { width: 80 });
        doc.moveDown(0.35);
      }
      // total du jour
      checkBreak(20);
      doc.rect(45, doc.y, pageWidth - 10, 18).fill(COLORS.slateLight);
      doc.fontSize(9).font('Helvetica-Bold').fillColor(COLORS.slate)
        .text(`Total du jour :  ${KG(jourKg)}   •   Encaissé : ${F(jourRecu)}   •   Reste : ${F(jourReste)}`, 52, doc.y + 5);
      doc.moveDown(1.2);
    }

    // ── 3. Totaux de la période ──
    sectionTitle('🧮', 'Totaux de la période');
    ligneKV('Kg déposé + valeur', `${KG(d.stockDepose.kg)}  —  ${F(d.stockDepose.valeur)}`);
    ligneKV('Total kg vendu', KG(d.totaux.kgVendu));
    ligneKV('Total encaissé', F(d.totaux.encaisse), { bold: true, color: COLORS.green });
    ligneKV('Total des restes', F(d.totaux.reste), { color: COLORS.red });
    ligneKV('Caisse totale (ventes + ajouts)', F(d.caisseTotale), { bold: true, color: COLORS.section });

    // ── 4. Mouvements de caisse ──
    sectionTitle('💰', 'Mouvements de caisse (entrées / sorties)');
    const tousMouvements = [
      ...d.mouvements.map(m => ({ date: m.date, type: m.type === 'ajout' ? '➕ Entrée' : '➖ Sortie', montant: m.montant, commentaire: m.commentaire, employe: m.employe })),
      ...d.encaissements.map(e => ({ date: e.date, type: '💸 Versement patron', montant: e.montant, commentaire: e.commentaire, employe: e.employe })),
    ].sort((a, b) => a.date.localeCompare(b.date));

    if (tousMouvements.length === 0) {
      doc.fontSize(10).fillColor('#94a3b8').text('Aucun mouvement de caisse sur cette période.', 48);
      doc.moveDown(0.5);
    }
    for (const m of tousMouvements) {
      checkBreak(16);
      doc.fontSize(9).font('Helvetica').fillColor('#334155');
      doc.text(m.date, 48, doc.y, { continued: true, width: 70 });
      doc.text(m.type, { continued: true, width: 120 });
      doc.text(m.employe || '—', { continued: true, width: 110 });
      doc.text(F(m.montant), { continued: true, width: 80, align: 'right' });
      doc.fillColor('#64748b').text(`  ${m.commentaire || ''}`);
      doc.moveDown(0.3);
    }
    checkBreak(20);
    doc.rect(45, doc.y, pageWidth - 10, 18).fill('#fef2f2');
    doc.fontSize(9).font('Helvetica-Bold').fillColor(COLORS.red)
      .text(`Total des sorties de la caisse (retraits + versements) : ${F(d.totalSorties)}`, 52, doc.y + 5);
    doc.moveDown(1.4);

    // ── 5. Récapitulatif final ──
    sectionTitle('📋', 'Récapitulatif final');
    ligneKV('1. Kg total déposé', KG(d.stockDepose.kg));
    ligneKV('2. Valeur du stock déposé', F(d.stockDepose.valeur));
    ligneKV('3. Total kg vendu', KG(d.totaux.kgVendu));
    ligneKV('4. Total encaissé', F(d.totaux.encaisse));
    ligneKV('5. Total des restes (non perçu)', F(d.totaux.reste));
    ligneKV('6. Total des entrées de caisse (ajouts)', F(d.totalAjouts));
    ligneKV('7. Total des retraits de caisse', F(d.totalRetraits));
    ligneKV('8. Total versé au patron', F(d.totalVerse));
    ligneKV('9. Total des sorties de caisse (retraits + versements)', F(d.totalSorties));
    ligneKV('10. Caisse totale (ventes + ajouts)', F(d.caisseTotale), { bold: true });
    ligneKV('11. Kg total perdu', KG(d.pertes.kg), { color: COLORS.red });
    ligneKV('12. Valeur totale perdue', F(d.pertes.valeur), { color: COLORS.red });

    doc.end();
  } catch (err) {
    console.error('genererRapportPDF:', err);
    if (!res.headersSent) res.status(500).json({ message: 'Erreur lors de la génération du rapport.' });
  }
};

module.exports = { genererRapportPDF };
