const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const ctrl = require('../controllers/notificationsController');
router.get('/', authenticate, ctrl.lister);
router.patch('/:id/lu', authenticate, ctrl.marquerLue);
router.delete('/', authenticate, ctrl.effacerToutes);
module.exports = router;
