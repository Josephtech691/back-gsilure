const express = require('express');
const router = express.Router();
const { traiterAlertesInactivite } = require('../controllers/inactivityController');
router.get('/inactivity', traiterAlertesInactivite);
module.exports = router;
