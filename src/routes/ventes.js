const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/ventesController');
const { authenticate, adminOnly } = require('../middleware/auth');
//const {ventesJournalier,revenusVentes} = require('../controllers/ventesController')

router.get('/journee', authenticate, ctrl.getOuCreerJournee);
router.post('/journee/:journeeId/clients', authenticate, ctrl.ajouterClient);
router.put('/clients/:clientId', authenticate, ctrl.modifierClient);
router.delete('/clients/:clientId', authenticate, ctrl.supprimerClient);
router.post('/clients/:clientId/annuler-reste', authenticate, ctrl.demanderAnnulationReste);
router.post('/mouvements-caisse', authenticate, ctrl.creerMouvementCaisse);
router.post('/encaissements', authenticate, ctrl.creerEncaissement);
router.get('/graphique', authenticate, ctrl.graphiqueEmploye);
router.get('/dashboard', authenticate, adminOnly, ctrl.dashboard);
router.get('/admin-graphiques', authenticate, adminOnly, ctrl.graphiquesAdmin);
router.get('/demandes', authenticate, adminOnly, ctrl.listerDemandes);
router.get('/parametres/employes', authenticate, adminOnly, ctrl.listerEmployesParametres);
router.get('/parametres/employes/:employe_id/journees', authenticate, adminOnly, ctrl.listerJourneesEmploye);
router.patch('/parametres/demandes/:id', authenticate, adminOnly, ctrl.modifierDemandeAdmin);
router.post('/parametres/journees/:journee_id/autoriser-historique', authenticate, adminOnly, ctrl.modifierJourneeHistorique);
router.patch('/demandes/:id', authenticate, adminOnly, ctrl.traiterDemande);
router.post('/demandes-modification', authenticate, ctrl.demanderModification);
// Il faut ajouter dans ventes.js :
router.get('/revenus', authenticate, adminOnly, ctrl.revenusVentes);
router.get('/journalier', authenticate, adminOnly, ctrl.ventesJournalier);
router.get('/restes/stats', authenticate, adminOnly, ctrl.statsRestes);

module.exports = router;