const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/rapportController');
const { authenticate, adminOnly } = require('../middleware/auth');

router.get('/generer', authenticate, adminOnly, ctrl.genererRapportPDF);

module.exports = router;
