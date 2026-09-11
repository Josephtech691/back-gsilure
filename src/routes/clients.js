const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/clientsController');
const { authenticate, adminOnly } = require('../middleware/auth');

router.get('/recherche', authenticate, ctrl.rechercherClients);
router.post('/', authenticate, ctrl.creerClient);
router.get('/', authenticate, adminOnly, ctrl.listerClients);
router.get('/:nom', authenticate, adminOnly, ctrl.detailClient);

module.exports = router;
