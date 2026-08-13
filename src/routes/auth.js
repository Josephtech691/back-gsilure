const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/authController');
const { authenticate, adminOnly } = require('../middleware/auth');
const upload = require('../config/upload');

router.post('/login', ctrl.login);
router.get('/me', authenticate, ctrl.me);
router.patch('/profil', authenticate, ctrl.mettreAJourProfil);
router.patch('/mot-de-passe', authenticate, ctrl.changerMotDePasse);
router.post('/avatar', authenticate, upload.single('avatar'), ctrl.uploadAvatar);
router.post('/creer-employe', authenticate, adminOnly, ctrl.creerEmploye);
router.get('/employes', authenticate, adminOnly, ctrl.listerEmployes);
router.get('/employes/:id', authenticate, adminOnly, ctrl.getEmploye);
router.patch('/employes/:id', authenticate, adminOnly, ctrl.modifierEmploye);
router.patch('/employes/:id/actif', authenticate, adminOnly, ctrl.toggleActifEmploye);

module.exports = router;
