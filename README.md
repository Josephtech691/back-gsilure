# Backend Vercel

Cette version est adaptée à Vercel Serverless.

## Changements principaux
- Express exporté via `api/index.js`.
- La logique de l'application est dans `src/app.js`.
- Aucun `server.listen()` n'est exécuté sur Vercel.
- Socket.IO a été retiré : utiliser les endpoints REST de `/api/chat`.
- Les avatars sont stockés dans Cloudinary, pas sur le disque local.
- Le pool PostgreSQL est réduit pour le contexte serverless.
- La route `/debug` a été supprimée.
- La configuration PostgreSQL dupliquée a été supprimée.

## Variables Vercel
Ajoutez les variables de `.env.example` dans Vercel > Settings > Environment Variables.

## Déploiement
1. Uploadez ce dossier sur GitHub.
2. Importez le dépôt dans Vercel.
3. Ajoutez les variables d'environnement.
4. Déployez.
5. Testez `GET /health`.

## Important : chat temps réel
Cette version conserve les routes REST du chat mais retire Socket.IO du serveur Vercel.
Si votre frontend utilisait Socket.IO, il doit être adapté aux endpoints REST existants ou Socket.IO doit être déployé sur un service WebSocket séparé.
"# back-gsilure" 

## Système de périodes du dashboard admin

Une migration SQL est fournie dans `database/periodes.sql`.
Elle crée `periodes_dashboard` et `dashboard_periode_config`.

À exécuter sur la même base PostgreSQL que l'application avant d'utiliser les nouvelles routes `/api/periodes`.

Routes admin :
- `GET /api/periodes` : historique + configuration de la période courante
- `POST /api/periodes` : créer une période (elle devient automatiquement la période active)
- `PATCH /api/periodes/toggle` : activer/désactiver le mode période
- `PATCH /api/periodes/:id/selectionner` : sélectionner une période historique

Les endpoints dashboard existants acceptent désormais `periode_id` pour les données de période :
- `GET /api/ventes/dashboard?periode_id=...`
- `GET /api/ventes/revenus?periode_id=...`
- `GET /api/ventes/journalier?periode_id=...`
- `GET /api/pertes/stats?periode_id=...`
- `GET /api/ventes/demandes?periode_id=...` ou `?mois=YYYY-MM`
