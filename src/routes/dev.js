const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/devController');
const { authenticate, devOnly } = require('../middleware/auth');

router.use(authenticate, devOnly);

router.get('/erreurs', ctrl.listerErreurs);
router.get('/erreurs/stats', ctrl.statsErreurs);
router.post('/erreurs/test', ctrl.erreurTest);
router.delete('/erreurs/resolues', ctrl.purgerResolues);
router.patch('/erreurs/:id', ctrl.majErreur);
router.get('/integrite', ctrl.integrite);
router.get('/sante', ctrl.sante);
router.get('/comptes', ctrl.comptes);

module.exports = router;
