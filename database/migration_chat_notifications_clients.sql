-- GSILURE : notifications persistantes, dernier achat et rappels clients inactifs
-- À exécuter une seule fois sur la base PostgreSQL de production.

ALTER TABLE clients_vente ADD COLUMN IF NOT EXISTS client_nom VARCHAR(150);

CREATE TABLE IF NOT EXISTS clients (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  nom VARCHAR(150) UNIQUE NOT NULL,
  telephone VARCHAR(30),
  type VARCHAR(20) NOT NULL DEFAULT 'simple',
  commentaire TEXT,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type VARCHAR(40) NOT NULL,
  message TEXT NOT NULL,
  entity_id TEXT,
  lu BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_notifications_user_date ON notifications(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications(user_id, lu);

CREATE TABLE IF NOT EXISTS alertes_inactivite_clients (
  client_nom VARCHAR(150) PRIMARY KEY,
  derniere_visite DATE NOT NULL,
  nombre_alertes SMALLINT NOT NULL DEFAULT 0 CHECK (nombre_alertes BETWEEN 0 AND 2),
  derniere_alerte_at TIMESTAMPTZ
);

-- Nouvelle demande : notification à tous les administrateurs.
CREATE OR REPLACE FUNCTION notifier_nouvelle_demande() RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO notifications (user_id, type, message, entity_id)
  SELECT id, 'demande', 'Nouvelle demande reçue : ' || NEW.type || ' — ' || NEW.motif, NEW.id::text
  FROM users WHERE role='admin' AND COALESCE(actif, TRUE)=TRUE;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_notifier_nouvelle_demande ON demandes;
CREATE TRIGGER trg_notifier_nouvelle_demande AFTER INSERT ON demandes
FOR EACH ROW EXECUTE FUNCTION notifier_nouvelle_demande();

-- Réponse à une demande : notification à l'employé demandeur.
CREATE OR REPLACE FUNCTION notifier_statut_demande() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.statut IS DISTINCT FROM OLD.statut AND NEW.statut IN ('approuvee','refusee') THEN
    INSERT INTO notifications (user_id, type, message, entity_id)
    VALUES (NEW.employe_id, 'demande_reponse',
      'Votre demande (' || NEW.type || ') a été ' || CASE WHEN NEW.statut='approuvee' THEN 'approuvée.' ELSE 'refusée.' END, NEW.id::text);
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_notifier_statut_demande ON demandes;
CREATE TRIGGER trg_notifier_statut_demande AFTER UPDATE OF statut ON demandes
FOR EACH ROW EXECUTE FUNCTION notifier_statut_demande();

-- Nouveau message : notification à tous les autres utilisateurs actifs.
CREATE OR REPLACE FUNCTION notifier_nouveau_message() RETURNS TRIGGER AS $$
DECLARE auteur TEXT;
BEGIN
  SELECT prenom || ' ' || nom INTO auteur FROM users WHERE id=NEW.auteur_id;
  INSERT INTO notifications (user_id, type, message, entity_id)
  SELECT id, 'message', 'Nouveau message de ' || COALESCE(auteur, 'un utilisateur') || ' dans la discussion du ' || NEW.date_salon, NEW.id::text
  FROM users WHERE id <> NEW.auteur_id AND COALESCE(actif, TRUE)=TRUE;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_notifier_nouveau_message ON messages_chat;
CREATE TRIGGER trg_notifier_nouveau_message AFTER INSERT ON messages_chat
FOR EACH ROW EXECUTE FUNCTION notifier_nouveau_message();
