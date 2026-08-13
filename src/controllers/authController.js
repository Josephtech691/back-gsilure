const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const streamifier = require('streamifier');
const db = require('../config/db');
const { cloudinary, assertCloudinaryConfigured } = require('../config/cloudinary');

const SALT_ROUNDS = 10;
const TOKEN_EXPIRY = '8h';

const login = async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ message: 'Email et mot de passe requis.' });
  try {
    const result = await db.query(
      'SELECT * FROM users WHERE email = $1 AND actif = TRUE',
      [email.toLowerCase().trim()]
    );
    if (!result.rows.length)
      return res.status(401).json({ message: 'Identifiants incorrects.' });
    const user = result.rows[0];
    if (!(await bcrypt.compare(password, user.password_hash)))
      return res.status(401).json({ message: 'Identifiants incorrects.' });
    const payload = { id: user.id, email: user.email, role: user.role, nom: user.nom, prenom: user.prenom, photo_url: user.photo_url };
    const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: TOKEN_EXPIRY });
    res.json({ token, user: payload });
  } catch (err) {
    console.error('login:', err);
    res.status(500).json({ message: 'Erreur serveur.' });
  }
};

const me = async (req, res) => {
  try {
    const r = await db.query(
      'SELECT id, nom, prenom, email, role, photo_url, telephone, created_at FROM users WHERE id = $1',
      [req.user.id]
    );
    if (!r.rows.length) return res.status(404).json({ message: 'Utilisateur non trouvé.' });
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ message: 'Erreur serveur.' }); }
};

const mettreAJourProfil = async (req, res) => {
  const { nom, prenom, telephone } = req.body;
  try {
    const r = await db.query(
      `UPDATE users SET nom = COALESCE($1, nom), prenom = COALESCE($2, prenom),
       telephone = COALESCE($3, telephone), updated_at = NOW()
       WHERE id = $4
       RETURNING id, nom, prenom, email, role, photo_url, telephone`,
      [nom || null, prenom || null, telephone || null, req.user.id]
    );
    res.json({ message: 'Profil mis à jour.', user: r.rows[0] });
  } catch (err) {
    console.error('mettreAJourProfil:', err);
    res.status(500).json({ message: 'Erreur serveur.' });
  }
};

const changerMotDePasse = async (req, res) => {
  const { ancien_mdp, nouveau_mdp } = req.body;
  if (!ancien_mdp || !nouveau_mdp)
    return res.status(400).json({ message: 'Ancien et nouveau mot de passe requis.' });
  if (nouveau_mdp.length < 8)
    return res.status(400).json({ message: 'Minimum 8 caractères.' });
  try {
    const r = await db.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
    if (!r.rows.length) return res.status(404).json({ message: 'Utilisateur non trouvé.' });
    if (!(await bcrypt.compare(ancien_mdp, r.rows[0].password_hash)))
      return res.status(401).json({ message: 'Ancien mot de passe incorrect.' });
    const hash = await bcrypt.hash(nouveau_mdp, SALT_ROUNDS);
    await db.query('UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2', [hash, req.user.id]);
    res.json({ message: 'Mot de passe modifié avec succès.' });
  } catch (err) {
    console.error('changerMotDePasse:', err);
    res.status(500).json({ message: 'Erreur serveur.' });
  }
};

// Upload avatar vers Cloudinary (stockage persistant, compatible Vercel)
const uploadAvatar = async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ message: 'Aucun fichier envoyé.' });
  }

  try {
    assertCloudinaryConfigured();

    const old = await db.query(
      'SELECT photo_url FROM users WHERE id = $1',
      [req.user.id]
    );

    const publicId = `poissonnerie/avatars/${req.user.id}`;

    // Upload from Multer memory buffer. overwrite=true keeps one avatar per user.
    const result = await new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        {
          public_id: publicId,
          overwrite: true,
          resource_type: 'image',
          folder: undefined,
          transformation: [
            { width: 512, height: 512, crop: 'limit' },
            { quality: 'auto', fetch_format: 'auto' },
          ],
        },
        (error, uploadResult) => {
          if (error) return reject(error);
          resolve(uploadResult);
        }
      );

      streamifier.createReadStream(req.file.buffer).pipe(uploadStream);
    });

    const photo_url = result.secure_url;

    await db.query(
      'UPDATE users SET photo_url = $1, updated_at = NOW() WHERE id = $2',
      [photo_url, req.user.id]
    );

    res.json({ message: 'Photo mise à jour.', photo_url });
  } catch (err) {
    console.error('uploadAvatar:', err);
    res.status(err.status || 500).json({
      message: err.message || 'Erreur lors de l’upload de la photo.',
    });
  }
};

const creerEmploye = async (req, res) => {
  const { nom, prenom, email, password, telephone } = req.body;
  if (!nom || !prenom || !email || !password)
    return res.status(400).json({ message: 'Tous les champs obligatoires sont requis.' });
  if (password.length < 6)
    return res.status(400).json({ message: 'Mot de passe trop court (6 min).' });
  try {
    const exists = await db.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase().trim()]);
    if (exists.rows.length) return res.status(409).json({ message: 'Email déjà utilisé.' });
    const hash = await bcrypt.hash(password, SALT_ROUNDS);
    const r = await db.query(
      `INSERT INTO users (nom, prenom, email, password_hash, role, telephone)
       VALUES ($1,$2,$3,$4,'employee',$5)
       RETURNING id, nom, prenom, email, role, telephone, created_at`,
      [nom.trim(), prenom.trim(), email.toLowerCase().trim(), hash, telephone || null]
    );
    res.status(201).json({ message: 'Compte employé créé.', employe: r.rows[0] });
  } catch (err) {
    console.error('creerEmploye:', err);
    res.status(500).json({ message: 'Erreur serveur.' });
  }
};

const listerEmployes = async (req, res) => {
  try {
    const r = await db.query(
      `SELECT id, nom, prenom, email, photo_url, telephone, actif, created_at
       FROM users WHERE role = 'employee' ORDER BY nom, prenom`
    );
    res.json(r.rows);
  } catch (err) { res.status(500).json({ message: 'Erreur serveur.' }); }
};

const getEmploye = async (req, res) => {
  const { id } = req.params;
  try {
    const user = await db.query(
      "SELECT id, nom, prenom, email, photo_url, telephone, actif, created_at FROM users WHERE id = $1 AND role = 'employee'",
      [id]
    );
    if (!user.rows.length) return res.status(404).json({ message: 'Employé non trouvé.' });
    const stats = await db.query(`
      SELECT COALESCE(SUM(cv.kg_achetes), 0) AS total_kg,
             COALESCE(SUM(cv.montant_recu), 0) AS total_encaisse,
             COUNT(DISTINCT vj.date_vente) AS nb_jours_travailles,
             COUNT(cv.id) AS nb_clients
      FROM ventes_journees vj
      LEFT JOIN clients_vente cv ON cv.journee_id = vj.id
      WHERE vj.employe_id = $1`, [id]);
    res.json({ employe: user.rows[0], stats: stats.rows[0] });
  } catch (err) {
    console.error('getEmploye:', err);
    res.status(500).json({ message: 'Erreur serveur.' });
  }
};

const modifierEmploye = async (req, res) => {
  const { id } = req.params;
  const { nom, prenom, telephone, actif, nouveau_mdp } = req.body;
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE users SET nom = COALESCE($1, nom), prenom = COALESCE($2, prenom),
       telephone = COALESCE($3, telephone), actif = COALESCE($4, actif), updated_at = NOW()
       WHERE id = $5 AND role = 'employee'`,
      [nom || null, prenom || null, telephone || null, actif ?? null, id]
    );
    if (nouveau_mdp) {
      if (nouveau_mdp.length < 6) { await client.query('ROLLBACK'); return res.status(400).json({ message: 'Mot de passe trop court.' }); }
      const hash = await bcrypt.hash(nouveau_mdp, SALT_ROUNDS);
      await client.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, id]);
    }
    const updated = await client.query('SELECT id, nom, prenom, email, photo_url, telephone, actif FROM users WHERE id = $1', [id]);
    await client.query('COMMIT');
    res.json({ message: 'Employé mis à jour.', employe: updated.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('modifierEmploye:', err);
    res.status(500).json({ message: 'Erreur serveur.' });
  } finally { client.release(); }
};

const toggleActifEmploye = async (req, res) => {
  const { id } = req.params;
  const { actif } = req.body;
  try {
    const r = await db.query(
      "UPDATE users SET actif = $1 WHERE id = $2 AND role = 'employee' RETURNING id, nom, prenom, actif",
      [actif, id]
    );
    if (!r.rows.length) return res.status(404).json({ message: 'Employé non trouvé.' });
    res.json({ message: `Compte ${actif ? 'activé' : 'désactivé'}.`, employe: r.rows[0] });
  } catch (err) { res.status(500).json({ message: 'Erreur serveur.' }); }
};

module.exports = {
  login, me, mettreAJourProfil, changerMotDePasse, uploadAvatar,
  creerEmploye, listerEmployes, getEmploye, modifierEmploye, toggleActifEmploye,
};
