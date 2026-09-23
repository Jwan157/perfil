const express = require("express");
const session = require("express-session");
const { Pool } = require("pg");
const connectPgSimple = require("connect-pg-simple")(session);
const path = require("path");
const fs = require("fs");
const fsp = require("fs/promises");
const { issueSignedToken, presignUrl, head, del } = require("@vercel/blob");
const crypto = require("crypto");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = path.join(__dirname, "private_uploads");
const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100 MB por archivo
const IS_VERCEL = process.env.VERCEL === "1" || !!process.env.VERCEL_ENV;

// ============================================================
// CONFIGURACIÓN DE POSTGRESQL
// ============================================================

const pool = new Pool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD
});

// ============================================================
// MIDDLEWARES
// ============================================================

app.use(express.json());

app.set("trust proxy", 1);

app.use(
    session({
        store: new connectPgSimple({
            pool,
            createTableIfMissing: true
        }),
        secret:
            process.env.SESSION_SECRET ||
            "clave-secreta-cambiar",
        resave: false,
        saveUninitialized: false,
        cookie: {
            maxAge: 1000 * 60 * 60 * 24,
            secure: IS_VERCEL,
            httpOnly: true,
            sameSite: "lax"
        }
    })
);

// Garantiza que las tablas existan antes de procesar las rutas que usan PostgreSQL.
app.use(async (req, res, next) => {
    try {
        await asegurarBaseDatos();
        next();
    } catch (error) {
        console.error("Error inicializando PostgreSQL:", error.message);
        next();
    }
});

// Servir la carpeta public
app.use(express.static(path.join(__dirname, "public")));

// ============================================================
// PREPARAR BASE DE DATOS
// ============================================================

async function prepararBaseDatos() {
    try {

        // --------------------------------------------------------
        // TABLA USUARIOS
        // --------------------------------------------------------

        await pool.query(`
            CREATE TABLE IF NOT EXISTS usuarios (
                discord_id VARCHAR(50) PRIMARY KEY,
                username VARCHAR(100) NOT NULL,
                avatar VARCHAR(255)
            );
        `);

        // --------------------------------------------------------
        // TABLA VISITAS
        // --------------------------------------------------------

        await pool.query(`
            CREATE TABLE IF NOT EXISTS archivos (
                id SERIAL PRIMARY KEY,
                nombre VARCHAR(255) NOT NULL,
                nombre_guardado VARCHAR(255) NOT NULL UNIQUE,
                categoria VARCHAR(60) NOT NULL DEFAULT 'otros',
                tipo VARCHAR(180),
                tamano BIGINT NOT NULL DEFAULT 0,
                fecha TIMESTAMP WITH TIME ZONE DEFAULT NOW()
            );
        `);

        await pool.query(`
            ALTER TABLE archivos
            ADD COLUMN IF NOT EXISTS blob_pathname VARCHAR(500);
        `);

        await pool.query(`
            ALTER TABLE archivos
            ADD COLUMN IF NOT EXISTS blob_url TEXT;
        `);

        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_archivos_fecha
            ON archivos(fecha DESC);
        `);

        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_archivos_categoria
            ON archivos(categoria);
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS visitas (
                id SERIAL PRIMARY KEY,
                fecha TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
                ip VARCHAR(100),
                pais VARCHAR(100),
                departamento VARCHAR(100),
                ciudad VARCHAR(100),
                isp VARCHAR(255)
            );
        `);

        // --------------------------------------------------------
        // SI LA TABLA YA EXISTÍA, AGREGAR ISP
        // --------------------------------------------------------

        await pool.query(`
            ALTER TABLE visitas
            ADD COLUMN IF NOT EXISTS isp VARCHAR(255);
        `);
await pool.query(`
    ALTER TABLE visitas
    ADD COLUMN IF NOT EXISTS discord_usuario VARCHAR(100);
`);
        // --------------------------------------------------------
        // ÍNDICE
        // --------------------------------------------------------

        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_visitas_fecha
            ON visitas(fecha);
        `);

        if (!IS_VERCEL) {
            await fsp.mkdir(UPLOAD_DIR, { recursive: true });
        }
        console.log("Base de datos preparada.");

    } catch (error) {

        console.error(
            "Error preparando la base de datos:",
            error.message
        );
    }
}

// ============================================================
// PRUEBA DE BASE DE DATOS
// ============================================================

app.get("/api/test-db", async (req, res) => {

    try {

        const resultado =
            await pool.query(
                "SELECT NOW() AS ahora"
            );

        res.json({
            ok: true,
            mensaje:
                "Conexión con PostgreSQL correcta",
            fecha:
                resultado.rows[0].ahora
        });

    } catch (error) {

        console.error(
            "Error en prueba de BD:",
            error.message
        );

        res.status(500).json({
            ok: false,
            error: error.message
        });
    }
});

// ============================================================
// DISCORD OAUTH
// ============================================================

app.get("/auth/discord", (req, res) => {

    const clientId =
        process.env.DISCORD_CLIENT_ID;

    const redirectUri =
        process.env.DISCORD_REDIRECT_URI;

    if (!clientId || !redirectUri) {

        return res.status(500).send(
            "Faltan las variables de Discord en el archivo .env"
        );
    }

    const params =
        new URLSearchParams({

            client_id: clientId,

            redirect_uri: redirectUri,

            response_type: "code",

            scope: "identify email"

        });

    res.redirect(
        "https://discord.com/oauth2/authorize?" +
        params.toString()
    );
});

// ============================================================
// CALLBACK DE DISCORD
// ============================================================

app.get(
    "/paper-rex/discord/callback",
    async (req, res) => {

        const { code } = req.query;

        if (!code) {

            return res.status(400).send(
                "No se recibió el código de Discord."
            );
        }

        try {

            // ----------------------------------------------------
            // OBTENER TOKEN
            // ----------------------------------------------------

            const tokenResponse =
                await fetch(
                    "https://discord.com/api/oauth2/token",
                    {
                        method: "POST",

                        headers: {
                            "Content-Type":
                                "application/x-www-form-urlencoded"
                        },

                        body:
                            new URLSearchParams({

                                client_id:
                                    process.env.DISCORD_CLIENT_ID,

                                client_secret:
                                    process.env.DISCORD_CLIENT_SECRET,

                                grant_type:
                                    "authorization_code",

                                code:
                                    code,

                                redirect_uri:
                                    process.env.DISCORD_REDIRECT_URI

                            })
                    }
                );

            const tokenData =
                await tokenResponse.json();

            if (!tokenResponse.ok) {

                console.error(
                    "Error obteniendo token:",
                    tokenData
                );

                return res.status(500).send(
                    "No se pudo iniciar sesión con Discord."
                );
            }

            // ----------------------------------------------------
            // OBTENER USUARIO DE DISCORD
            // ----------------------------------------------------

            const userResponse =
                await fetch(
                    "https://discord.com/api/users/@me",
                    {
                        headers: {
                            Authorization:
                                `${tokenData.token_type} ${tokenData.access_token}`
                        }
                    }
                );

            const userData =
                await userResponse.json();

            if (!userResponse.ok) {

                console.error(
                    "Error obteniendo usuario:",
                    userData
                );

                return res.status(500).send(
                    "No se pudo obtener el usuario de Discord."
                );
            }

            // ----------------------------------------------------
            // AVATAR
            // ----------------------------------------------------

            const avatar =
                userData.avatar
                    ? `https://cdn.discordapp.com/avatars/${userData.id}/${userData.avatar}.png`
                    : null;

            // ----------------------------------------------------
            // GUARDAR USUARIO
            // ----------------------------------------------------

            await pool.query(
                `
                INSERT INTO usuarios
                    (
                        discord_id,
                        username,
                        avatar
                    )
                VALUES
                    (
                        $1,
                        $2,
                        $3
                    )

                ON CONFLICT (discord_id)
                DO UPDATE SET
                    username = EXCLUDED.username,
                    avatar = EXCLUDED.avatar
                `,
                [
                    userData.id,
                    userData.username,
                    avatar
                ]
            );

            // ----------------------------------------------------
            // CREAR SESIÓN
            // ----------------------------------------------------

            req.session.user = {

                id:
                    userData.id,

                username:
                    userData.username,

                avatar:
                    avatar

            };

            res.redirect("/");

        } catch (error) {

            console.error(
                "Error en Discord OAuth:",
                error.message
            );

            res.status(500).send(
                "Ocurrió un error al iniciar sesión."
            );
        }
    }
);

// ============================================================
// USUARIO ACTUAL
// ============================================================

app.get("/api/me", (req, res) => {

    if (!req.session.user) {

        return res.json({
            loggedIn: false
        });
    }

    res.json({

        loggedIn: true,

        user:
            req.session.user

    });
});

// ============================================================
// CERRAR SESIÓN DE DISCORD
// ============================================================

app.get("/auth/logout", (req, res) => {

    req.session.destroy(() => {

        res.redirect("/");

    });
});

// ============================================================
// LOGIN DE ZONA PRIVADA
// ============================================================

app.post("/api/private-login", (req, res) => {

    const { password } = req.body;

    if (!password) {

        return res.status(400).json({

            ok: false,

            mensaje:
                "Introduce la contraseña."

        });
    }

    /*
       Se limpian espacios accidentales para evitar
       problemas al copiar y pegar.
    */

    const inputLimpio =
        String(password)
            .trim()
            .replace(/\s+/g, "");

    const claveEnv =
        String(
            process.env.PRIVATE_PASSWORD || ""
        )
            .trim()
            .replace(/\s+/g, "");

    if (inputLimpio !== claveEnv) {

        return res.status(401).json({

            ok: false,

            mensaje:
                "Contraseña incorrecta."

        });
    }

    req.session.privateAccess = true;

    res.json({

        ok: true,

        mensaje:
            "Acceso concedido."

    });
});

// ============================================================
// COMPROBAR ACCESO PRIVADO
// ============================================================

app.get("/api/private-check", (req, res) => {

    res.json({

        access:
            req.session.privateAccess === true

    });
});

// ============================================================
// CERRAR ZONA PRIVADA
// ============================================================

app.post(
    "/api/private-logout",
    (req, res) => {

        req.session.privateAccess = false;

        res.json({
            ok: true
        });
    }
);
// ============================================================
// LOGIN DE VISTAS
// ============================================================

app.post("/api/vistas-login", (req, res) => {

    const { password } = req.body;

    const contraseñaCorrecta =
        process.env.VISTAS_PASSWORD;

    if (
        !contraseñaCorrecta ||
        password !== contraseñaCorrecta
    ) {

        return res.status(401).json({
            ok: false,
            mensaje: "Contraseña incorrecta."
        });

    }

    req.session.vistasAccess = true;

    res.json({
        ok: true,
        mensaje: "Acceso concedido."
    });

});


// ============================================================
// COMPROBAR ACCESO A VISTAS
// ============================================================

app.get("/api/vistas-check", (req, res) => {

    res.json({
        access:
            req.session.vistasAccess === true
    });

});
// ============================================================
// REGISTRAR VISITA
// IP + PAÍS + DEPARTAMENTO + CIUDAD + ISP
// ============================================================

app.get(
    "/api/visitas",
    async (req, res) => {

        try {

            // ----------------------------------------------------
            // OBTENER IP
            // ----------------------------------------------------

            let ip =
                req.headers["x-forwarded-for"] ||
                req.socket.remoteAddress ||
                "desconocida";

            // Si hay varias IP
            if (ip.includes(",")) {

                ip =
                    ip
                        .split(",")[0]
                        .trim();
            }

            // Convertir IPv4-mapped IPv6
            if (
                ip.startsWith("::ffff:")
            ) {

                ip =
                    ip.replace(
                        "::ffff:",
                        ""
                    );
            }

            // ----------------------------------------------------
            // DATOS DE UBICACIÓN
            // ----------------------------------------------------

            let pais = null;

            let departamento = null;

            let ciudad = null;

            let isp = null;

            // ----------------------------------------------------
            // LOCALHOST
            // ----------------------------------------------------

            if (
    ip === "127.0.0.1" ||
    ip === "::1" ||
    ip === "localhost"
) {

    try {

        console.log("Localhost detectado. Obteniendo IP pública...");

        const respuestaIP =
            await fetch("https://api64.ipify.org?format=json");

        const datosIP =
            await respuestaIP.json();

        if (datosIP.ip) {

            ip = datosIP.ip;

            console.log(
                "IP pública:",
                ip
            );

            const respuestaUbicacion =
                await fetch(
                    `https://ipwho.is/${encodeURIComponent(ip)}`
                );

            const datos =
                await respuestaUbicacion.json();

            if (datos.success) {

                pais =
                    datos.country ||
                    null;

                departamento =
                    datos.region ||
                    null;

                ciudad =
                    datos.city ||
                    null;

                isp =
                    datos.connection?.isp ||
                    null;

                console.log(
                    "País:",
                    pais
                );

                console.log(
                    "Departamento:",
                    departamento
                );

                console.log(
                    "Ciudad:",
                    ciudad
                );

                console.log(
                    "ISP:",
                    isp
                );

            } else {

                console.log(
                    "ipwho.is no pudo obtener la ubicación."
                );
            }

        }

    } catch (error) {

        console.log(
            "Error obteniendo IP pública o ubicación:",
            error.message
        );
    }
}

            // ----------------------------------------------------
            // IP PÚBLICA
            // ----------------------------------------------------

            else {

                try {

                    const respuesta =
                        await fetch(
                            `https://ipwho.is/${encodeURIComponent(ip)}`
                        );

                    const datos =
                        await respuesta.json();

                    if (datos.success) {

                        pais =
                            datos.country ||
                            null;

                        departamento =
                            datos.region ||
                            null;

                        ciudad =
                            datos.city ||
                            null;

                        isp =
                            datos.connection?.isp ||
                            null;
                    }

                } catch (error) {

                    console.log(
                        "No se pudo obtener la ubicación:",
                        error.message
                    );
                }
            }

            // ----------------------------------------------------
            // GUARDAR VISITA
            // ----------------------------------------------------

            await pool.query(
                `
                INSERT INTO visitas
                    (
                        ip,
                        pais,
                        departamento,
                        ciudad,
                        isp
                    )
                VALUES
                    (
                        $1,
                        $2,
                        $3,
                        $4,
                        $5
                    )
                `,
                [
                    ip,
                    pais,
                    departamento,
                    ciudad,
                    isp
                ]
            );

            // ----------------------------------------------------
            // CONTAR VISITAS
            // ----------------------------------------------------

            const resultado =
                await pool.query(
                    "SELECT COUNT(*) FROM visitas"
                );

            const visitas =
                parseInt(
                    resultado.rows[0].count
                );

            res.json({

                visitas:
                    visitas

            });

        } catch (error) {

            console.error(
                "Error registrando visita:",
                error.message
            );

            res.json({

                visitas: 0

            });
        }
    }
);

// ============================================================
// LISTA DE VISITAS
// SOLO PARA EL ÁREA PRIVADA
// ============================================================

app.get(
    "/api/visitas/lista",
    async (req, res) => {

        try {

            // ----------------------------------------------------
            // COMPROBAR ACCESO
            // ----------------------------------------------------

            if (
    req.session.privateAccess !== true ||
    req.session.vistasAccess !== true
) {

                return res.status(403).json({

                    ok: false,

                    mensaje:
                        "Acceso denegado."

                });
            }

            // ----------------------------------------------------
            // OBTENER VISITAS
            // ----------------------------------------------------

            const resultado =
                await pool.query(
                    `
                    SELECT
                        id,
                        fecha,
                        ip,
                        pais,
                        departamento,
                        ciudad,
                        isp
                    FROM visitas
                    ORDER BY fecha DESC
                    `
                );

            res.json({

                ok: true,

                visitas:
                    resultado.rows

            });

        } catch (error) {

            console.error(
                "Error obteniendo visitas:",
                error.message
            );

            res.status(500).json({

                ok: false,

                mensaje:
                    "Error obteniendo las visitas."

            });
        }
    }
);

// ============================================================
// ARCHIVOS PRIVADOS — ARRASTRAR Y SOLTAR
// Vercel: Vercel Blob privado + URLs firmadas
// Local: almacenamiento local para seguir probando sin Blob
// ============================================================

function comprobarAccesoArchivos(req, res, next) {
    if (req.session.privateAccess !== true) {
        return res.status(403).json({
            ok: false,
            mensaje: "Acceso denegado."
        });
    }
    next();
}

function limpiarNombreArchivo(nombre) {
    return path.basename(String(nombre || "archivo"))
        .replace(/[^\w.\- ()áéíóúÁÉÍÓÚñÑ]/g, "_")
        .slice(0, 180) || "archivo";
}

function categoriaValida(categoria) {
    const permitidas = ["optimizaciones", "instaladores", "herramientas", "otros"];
    return permitidas.includes(categoria) ? categoria : "otros";
}

function extensionSegura(nombre) {
    return path.extname(nombre).slice(0, 20).replace(/[^\w.]/g, "") || "";
}

function blobActivo() {
    return IS_VERCEL;
}

app.get("/api/archivos", comprobarAccesoArchivos, async (req, res) => {
    try {
        const categoria = req.query.categoria ? categoriaValida(req.query.categoria) : null;
        const resultado = categoria
            ? await pool.query(
                `SELECT id, nombre, categoria, tipo, tamano, fecha
                 FROM archivos WHERE categoria = $1 ORDER BY fecha DESC`,
                [categoria]
            )
            : await pool.query(
                `SELECT id, nombre, categoria, tipo, tamano, fecha
                 FROM archivos ORDER BY fecha DESC`
            );

        res.json({ ok: true, archivos: resultado.rows });
    } catch (error) {
        console.error("Error listando archivos:", error.message);
        res.status(500).json({ ok: false, mensaje: "No se pudieron cargar los archivos." });
    }
});

// Vercel Blob: el navegador sube directamente al Blob con una URL firmada.
app.post("/api/archivos/upload-url", comprobarAccesoArchivos, async (req, res) => {
    if (!blobActivo()) {
        return res.status(400).json({ ok: false, modo: "local", mensaje: "El almacenamiento Blob se activa al desplegar en Vercel." });
    }

    try {
        const nombreOriginal = limpiarNombreArchivo(req.body?.nombre);
        const categoria = categoriaValida(req.body?.categoria);
        const tipo = String(req.body?.tipo || "application/octet-stream").slice(0, 180);
        const tamano = Number(req.body?.tamano || 0);

        if (!tamano || tamano > MAX_FILE_SIZE) {
            return res.status(413).json({ ok: false, mensaje: "El archivo debe pesar entre 1 B y 100 MB." });
        }

        const pathname = `archivos/${categoria}/${crypto.randomUUID()}${extensionSegura(nombreOriginal)}`;
        const validUntil = Date.now() + 15 * 60 * 1000;

        const token = await issueSignedToken({
            pathname,
            operations: ["put"],
            validUntil,
            allowedContentTypes: [tipo],
            maximumSizeInBytes: MAX_FILE_SIZE
        });

        const { presignedUrl } = await presignUrl(token, {
            pathname,
            operation: "put",
            validUntil,
            allowedContentTypes: [tipo],
            maximumSizeInBytes: MAX_FILE_SIZE,
            access: "private"
        });

        res.json({
            ok: true,
            modo: "blob",
            pathname,
            presignedUrl,
            nombre: nombreOriginal,
            categoria,
            tipo,
            tamano
        });
    } catch (error) {
        console.error("Error generando URL de Blob:", error);
        res.status(500).json({ ok: false, mensaje: "No se pudo preparar la subida a Vercel Blob." });
    }
});

// Confirma en PostgreSQL que el objeto realmente existe en Blob antes de guardar el registro.
app.post("/api/archivos/finalize", comprobarAccesoArchivos, async (req, res) => {
    if (!blobActivo()) {
        return res.status(400).json({ ok: false, mensaje: "Este endpoint es para Vercel Blob." });
    }

    try {
        const pathname = String(req.body?.pathname || "");
        const nombre = limpiarNombreArchivo(req.body?.nombre);
        const categoria = categoriaValida(req.body?.categoria);
        const tipo = String(req.body?.tipo || "application/octet-stream").slice(0, 180);

        if (!pathname.startsWith("archivos/") || pathname.length > 500) {
            return res.status(400).json({ ok: false, mensaje: "Ruta de archivo no válida." });
        }

        const blob = await head(pathname, { access: "private" });
        const tamano = Number(blob.size || 0);

        if (!tamano || tamano > MAX_FILE_SIZE) {
            return res.status(413).json({ ok: false, mensaje: "El archivo supera el límite permitido." });
        }

        const resultado = await pool.query(
            `INSERT INTO archivos (nombre, nombre_guardado, categoria, tipo, tamano, blob_pathname, blob_url)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             RETURNING id, nombre, categoria, tipo, tamano, fecha`,
            [nombre, pathname, categoria, typeSeguro(tipo, blob.contentType), tamano, pathname, blob.url]
        );

        res.status(201).json({ ok: true, archivo: resultado.rows[0] });
    } catch (error) {
        console.error("Error finalizando archivo Blob:", error);
        res.status(500).json({ ok: false, mensaje: "El archivo se subió, pero no se pudo registrar en PostgreSQL." });
    }
});

function typeSeguro(preferido, real) {
    const valor = String(real || preferido || "application/octet-stream").slice(0, 180);
    return valor;
}

// Ruta local de subida: se mantiene para trabajar en el PC sin Vercel.
app.post(
    "/api/archivos/upload",
    comprobarAccesoArchivos,
    express.raw({ type: "*/*", limit: "100mb" }),
    async (req, res) => {
        if (blobActivo()) {
            return res.status(400).json({ ok: false, mensaje: "En Vercel usa /api/archivos/upload-url para subir directamente a Blob." });
        }
        try {
            const nombreOriginal = limpiarNombreArchivo(decodeURIComponent(String(req.headers["x-file-name"] || "archivo")));
            const categoria = categoriaValida(req.headers["x-file-category"]);
            const tipo = String(req.headers["x-file-type"] || "application/octet-stream").slice(0, 180);
            const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || "");

            if (!buffer.length) return res.status(400).json({ ok: false, mensaje: "El archivo está vacío." });
            if (buffer.length > MAX_FILE_SIZE) return res.status(413).json({ ok: false, mensaje: "El archivo supera el límite de 100 MB." });

            const extension = extensionSegura(nombreOriginal);
            const nombreGuardado = `${crypto.randomUUID()}${extension}`;
            const destino = path.join(UPLOAD_DIR, nombreGuardado);

            await fsp.mkdir(UPLOAD_DIR, { recursive: true });
            await fsp.writeFile(destino, buffer, { flag: "wx" });

            const resultado = await pool.query(
                `INSERT INTO archivos (nombre, nombre_guardado, categoria, tipo, tamano)
                 VALUES ($1, $2, $3, $4, $5)
                 RETURNING id, nombre, categoria, tipo, tamano, fecha`,
                [nombreOriginal, nombreGuardado, categoria, tipo, buffer.length]
            );

            res.status(201).json({ ok: true, archivo: resultado.rows[0] });
        } catch (error) {
            console.error("Error subiendo archivo local:", error.message);
            res.status(500).json({ ok: false, mensaje: "No se pudo guardar el archivo." });
        }
    }
);

app.get("/api/archivos/:id/download", comprobarAccesoArchivos, async (req, res) => {
    try {
        const resultado = await pool.query(
            `SELECT id, nombre, nombre_guardado, tipo, blob_pathname FROM archivos WHERE id = $1`,
            [req.params.id]
        );

        if (!resultado.rows.length) return res.status(404).send("Archivo no encontrado.");

        const archivo = resultado.rows[0];

        if (blobActivo()) {
            const pathname = archivo.blob_pathname || archivo.nombre_guardado;
            if (!pathname || !pathname.startsWith("archivos/")) return res.status(404).send("Archivo no disponible.");

            const validUntil = Date.now() + 10 * 60 * 1000;
            const token = await issueSignedToken({ pathname, operations: ["get"], validUntil });
            const { presignedUrl } = await presignUrl(token, {
                pathname,
                operation: "get",
                validUntil,
                access: "private"
            });
            return res.redirect(302, presignedUrl);
        }

        const ruta = path.join(UPLOAD_DIR, archivo.nombre_guardado);
        if (!fs.existsSync(ruta)) return res.status(404).send("El archivo ya no existe en el almacenamiento local.");
        res.download(ruta, archivo.nombre, { maxAge: 0 });
    } catch (error) {
        console.error("Error descargando archivo:", error.message);
        res.status(500).send("No se pudo descargar el archivo.");
    }
});

app.delete("/api/archivos/:id", comprobarAccesoArchivos, async (req, res) => {
    try {
        const resultado = await pool.query(
            `SELECT nombre_guardado, blob_pathname FROM archivos WHERE id = $1`,
            [req.params.id]
        );

        if (!resultado.rows.length) return res.status(404).json({ ok: false, mensaje: "Archivo no encontrado." });

        const { nombre_guardado: nombreGuardado, blob_pathname: blobPathname } = resultado.rows[0];

        if (blobActivo()) {
            const pathname = blobPathname || nombreGuardado;
            if (pathname && pathname.startsWith("archivos/")) {
                await del(pathname, { access: "private" });
            }
        } else {
            const ruta = path.join(UPLOAD_DIR, nombreGuardado);
            try { await fsp.unlink(ruta); } catch (error) { if (error.code !== "ENOENT") throw error; }
        }

        await pool.query(`DELETE FROM archivos WHERE id = $1`, [req.params.id]);
        res.json({ ok: true });
    } catch (error) {
        console.error("Error eliminando archivo:", error.message);
        res.status(500).json({ ok: false, mensaje: "No se pudo eliminar el archivo." });
    }
});

// ============================================================
// INICIAR SERVIDOR / VERCEL
// ============================================================

let dbInitPromise;
function asegurarBaseDatos() {
    if (!dbInitPromise) dbInitPromise = prepararBaseDatos();
    return dbInitPromise;
}

// En Vercel Express se exporta la app; Vercel gestiona el servidor HTTP.
// En local seguimos usando node server.js normalmente.
if (!IS_VERCEL) {
    asegurarBaseDatos().then(() => {
        app.listen(PORT, "0.0.0.0", () => {
            console.log("----------------------------------");
            console.log("DiscordProfile iniciado");
            console.log(`http://localhost:${PORT}`);
            console.log("----------------------------------");
        });
    });
} else {
    // Inicialización perezosa: no bloquea el arranque de la función.
    asegurarBaseDatos().catch(error => console.error("Error inicializando BD en Vercel:", error));
}

module.exports = app;
