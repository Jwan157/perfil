# JWANM V6 — Archivos con arrastrar y soltar

Se añadió una sección **☁️ Mis archivos** dentro del área privada sin eliminar las funciones anteriores.

## Cómo funciona

- **Mis archivos** abre el gestor visual de archivos.
- Puedes hacer clic en la zona de carga para seleccionar uno o varios archivos.
- Puedes arrastrar archivos directamente a la zona grande de carga.
- También puedes arrastrar un archivo **encima de las opciones del menú**:
  - 📈 Optimizaciones
  - 💿 Instaladores
  - 🛠️ Herramientas
  - 📁 Otros
- Al soltarlo sobre una opción, esa opción se convierte automáticamente en la categoría del archivo.
- Se muestra progreso de subida.
- Los archivos quedan registrados en PostgreSQL y guardados localmente en `private_uploads/`.
- Desde la lista puedes descargar o eliminar cada archivo.
- El acceso a listar, descargar, subir y eliminar está protegido por la sesión del área privada.
- Límite actual: **100 MB por archivo**.

## Importante para Vercel

Esta V6 mantiene el almacenamiento local para que funcione inmediatamente en el proyecto Node/Express de forma local. En Vercel, el almacenamiento del sistema de archivos de una función no debe usarse como almacenamiento persistente.

Para la versión final en Vercel, la misma interfaz puede conectarse a **Vercel Blob privado** y PostgreSQL puede seguir guardando la metadata. Así los archivos no dependen del disco temporal de Vercel.

No subas el archivo `.env` al repositorio público. Para Vercel, las credenciales deben configurarse como Environment Variables.
