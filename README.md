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
