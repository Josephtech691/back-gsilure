# Migration des périodes du dashboard

Le dashboard admin dépend des tables `periodes_dashboard` et `dashboard_periode_config`.

**Important :** `users.id` est un UUID dans le schéma V2. La migration `periodes.sql` utilise donc aussi des UUID pour `created_by`, `periode_id` et la clé de `periodes_dashboard`.

À appliquer une seule fois sur la même base PostgreSQL que `DATABASE_URL`, avant de déployer/utiliser le dashboard :

```sql
-- exécuter le contenu de database/periodes.sql
```

Si une ancienne version de cette migration a déjà été appliquée avec des types incompatibles, il faut la corriger/retirer avant de réexécuter la version actuelle, en conservant les données de périodes si elles existent.
