const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/periodeController');
const { authenticate, adminOnly } = require('../middleware/auth');

router.get('/', authenticate, adminOnly, ctrl.listerPeriodes);
router.post('/', authenticate, adminOnly, ctrl.creerPeriode);
router.patch('/toggle', authenticate, adminOnly, ctrl.activerDesactiverPeriode);
router.patch('/:id/selectionner', authenticate, adminOnly, ctrl.selectionnerPeriode);

module.exports = router;
