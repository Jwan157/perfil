# Jwanm V7 — Vercel + Blob privado

Esta versión mantiene la interfaz V6 y adapta el backend para Vercel.

## Qué cambia
- Express se exporta para Vercel y sigue funcionando con `node server.js` en local.
- Los archivos en Vercel se suben directamente a Vercel Blob privado mediante URLs firmadas.
- PostgreSQL guarda los metadatos del archivo y la ruta de Blob.
- Descargar genera una URL firmada temporal.
- Eliminar borra el objeto de Blob y el registro de PostgreSQL.
- En local se mantiene `private_uploads/` como fallback.

## Antes de desplegar
1. En Vercel conecta el Blob Store privado `jwanm-archivos` al proyecto.
2. Configura las variables de entorno de PostgreSQL, sesión, contraseñas y Discord en Vercel.
3. Cambia `DISCORD_REDIRECT_URI` al dominio de producción de Vercel y añade exactamente esa URL en Discord Developer Portal.
4. PostgreSQL debe ser un servidor accesible desde Internet/Vercel; `localhost` no sirve para producción.
5. Ejecuta `npm install` localmente para generar un nuevo `package-lock.json` si quieres trabajar localmente.

## Git
No subas `.env` ni `node_modules/`.
