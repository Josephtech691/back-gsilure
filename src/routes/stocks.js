const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/stockController');
const { authenticate, adminOnly } = require('../middleware/auth');

router.get('/resume', authenticate, ctrl.resumeStock);
router.get('/bacs', authenticate, ctrl.etatBacs);
router.get('/prix', authenticate, ctrl.listerPrix);
router.post('/prix', authenticate, adminOnly, ctrl.modifierPrix);
router.get('/', authenticate, adminOnly, ctrl.listerDepots);
router.post('/', authenticate, adminOnly, ctrl.ajouterDepot);
router.get('/retraits', authenticate, adminOnly, ctrl.listerRetraitsStock);
router.post('/retraits', authenticate, adminOnly, ctrl.retirerStock);
router.delete('/retraits/:id', authenticate, adminOnly, ctrl.supprimerRetraitStock);
router.delete('/:id', authenticate, adminOnly, ctrl.supprimerDepot);

module.exports = router;
