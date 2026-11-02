const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/caisseController');
const { authenticate, adminOnly } = require('../middleware/auth');

router.use(authenticate, adminOnly);
router.get('/resume', ctrl.resumeCaisse);
router.get('/historique', ctrl.historiqueCaisse);
router.post('/retraits', ctrl.retirerCaisseAdmin);

module.exports = router;
