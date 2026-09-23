const express = require("express");
const session = require("express-session");
const { Pool } = require("pg");
const path = require("path");
const fs = require("fs");
const fsp = require("fs/promises");
const crypto = require("crypto");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = path.join(__dirname, "private_uploads");
const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100 MB por archivo

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
        secret:
            process.env.SESSION_SECRET ||
            "clave-secreta-cambiar",

        resave: false,

        saveUninitialized: false,

        cookie: {
            maxAge: 1000 * 60 * 60 * 24
        }
    })
);

// Servir la carpeta public
app.use(express.static("public"));

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

        await fsp.mkdir(UPLOAD_DIR, { recursive: true });
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

app.post(
    "/api/archivos/upload",
    comprobarAccesoArchivos,
    express.raw({ type: "*/*", limit: "100mb" }),
    async (req, res) => {
        try {
            const nombreOriginal = limpiarNombreArchivo(decodeURIComponent(String(req.headers["x-file-name"] || "archivo")));
            const categoria = categoriaValida(req.headers["x-file-category"]);
            const tipo = String(req.headers["x-file-type"] || "application/octet-stream").slice(0, 180);
            const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || "");

            if (!buffer.length) {
                return res.status(400).json({ ok: false, mensaje: "El archivo está vacío." });
            }

            if (buffer.length > MAX_FILE_SIZE) {
                return res.status(413).json({ ok: false, mensaje: "El archivo supera el límite de 100 MB." });
            }

            const extension = path.extname(nombreOriginal).slice(0, 15);
            const nombreGuardado = `${crypto.randomUUID()}${extension}`;
            const destino = path.join(UPLOAD_DIR, nombreGuardado);

            await fsp.writeFile(destino, buffer, { flag: "wx" });

            const resultado = await pool.query(
                `INSERT INTO archivos (nombre, nombre_guardado, categoria, tipo, tamano)
                 VALUES ($1, $2, $3, $4, $5)
                 RETURNING id, nombre, categoria, tipo, tamano, fecha`,
                [nombreOriginal, nombreGuardado, categoria, tipo, buffer.length]
            );

            res.status(201).json({ ok: true, archivo: resultado.rows[0] });
        } catch (error) {
            console.error("Error subiendo archivo:", error.message);
            res.status(500).json({ ok: false, mensaje: "No se pudo guardar el archivo." });
        }
    }
);

app.get("/api/archivos/:id/download", comprobarAccesoArchivos, async (req, res) => {
    try {
        const resultado = await pool.query(
            `SELECT id, nombre, nombre_guardado, tipo FROM archivos WHERE id = $1`,
            [req.params.id]
        );

        if (!resultado.rows.length) {
            return res.status(404).send("Archivo no encontrado.");
        }

        const archivo = resultado.rows[0];
        const ruta = path.join(UPLOAD_DIR, archivo.nombre_guardado);

        if (!fs.existsSync(ruta)) {
            return res.status(404).send("El archivo ya no existe en el almacenamiento.");
        }

        res.download(ruta, archivo.nombre, { maxAge: 0 });
    } catch (error) {
        console.error("Error descargando archivo:", error.message);
        res.status(500).send("No se pudo descargar el archivo.");
    }
});

app.delete("/api/archivos/:id", comprobarAccesoArchivos, async (req, res) => {
    try {
        const resultado = await pool.query(
            `SELECT nombre_guardado FROM archivos WHERE id = $1`,
            [req.params.id]
        );

        if (!resultado.rows.length) {
            return res.status(404).json({ ok: false, mensaje: "Archivo no encontrado." });
        }

        const nombreGuardado = resultado.rows[0].nombre_guardado;
        const ruta = path.join(UPLOAD_DIR, nombreGuardado);

        await pool.query(`DELETE FROM archivos WHERE id = $1`, [req.params.id]);

        try {
            await fsp.unlink(ruta);
        } catch (error) {
            if (error.code !== "ENOENT") throw error;
        }

        res.json({ ok: true });
    } catch (error) {
        console.error("Error eliminando archivo:", error.message);
        res.status(500).json({ ok: false, mensaje: "No se pudo eliminar el archivo." });
    }
});

// ============================================================
// INICIAR SERVIDOR
// ============================================================

async function iniciarServidor() {

    await prepararBaseDatos();

    app.listen(
        PORT,
        "0.0.0.0",
        () => {

            console.log(
                "----------------------------------"
            );

            console.log(
                "DiscordProfile iniciado"
            );

            console.log(
                `http://jwanfps.local:${PORT}`
            );

            console.log(
                "----------------------------------"
            );
        }
    );
}

// ============================================================
// EJECUTAR
// ============================================================

iniciarServidor();