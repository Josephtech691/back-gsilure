const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/pertesController');
const { authenticate, adminOnly } = require('../middleware/auth');

router.post('/', authenticate, ctrl.declarerPerte);
router.get('/', authenticate, adminOnly, ctrl.listerPertes);
router.get('/stats', authenticate, ctrl.statsPertes);
router.delete('/:id', authenticate, adminOnly, ctrl.supprimerPerte);

module.exports = router;
