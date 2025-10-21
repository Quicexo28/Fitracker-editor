require('dotenv').config(); // Carga las variables de .env al inicio
const express = require('express');
const bodyParser = require('body-parser');
const { Octokit } = require('@octokit/rest'); // Cliente API de GitHub
const path = require('path');

const app = express();
const port = process.env.PORT || 3000; // Usa el puerto de Vercel/Netlify o 3000 localmente

// Configuración de Octokit (cliente de GitHub)
const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
const owner = process.env.GITHUB_OWNER;
const repo = process.env.GITHUB_REPO;
const filePath = process.env.FILE_PATH;
const branch = process.env.COMMIT_BRANCH || 'main';

app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public')); // Serviremos un archivo HTML estático

// --- Ruta para mostrar el formulario ---
app.get('/', (req, res) => {
    // Servimos un archivo HTML estático para el formulario
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- Ruta para añadir el ejercicio ---
app.post('/add-exercise', async (req, res) => {
    const { group, baseId, baseName /* , ...otros campos futuros */ } = req.body;

    // --- Validación básica (mejorar según necesidad) ---
    if (!group || !baseId || !baseName || !/^[a-z0-9-]+$/.test(baseId)) {
        return res.status(400).send('Datos incompletos o ID inválido.');
    }

    try {
        console.log("Intentando obtener el archivo:", filePath);
        // 1. Obtener el archivo actual de GitHub
        const { data: fileData } = await octokit.repos.getContent({
            owner,
            repo,
            path: filePath,
            ref: branch, // Asegúrate de obtenerlo de la rama correcta
        });

        // 2. Decodificar el contenido (está en base64)
        const content = Buffer.from(fileData.content, 'base64').toString('utf-8');
        const exerciseData = JSON.parse(content);
        console.log("Archivo JSON actual leído.");

        // 3. Añadir el nuevo ejercicio (lógica similar a la anterior)
        let groupIndex = exerciseData.findIndex(g => g.group.toLowerCase() === group.toLowerCase());
        if (groupIndex === -1) {
            exerciseData.push({ group: group, items: [] });
            groupIndex = exerciseData.length - 1;
        }

        const idExists = exerciseData.some(g => g.items.some(item => item.id === baseId)); // Simplificado
        if (idExists) {
            return res.status(400).send(`Error: El ID '${baseId}' ya existe.`);
        }

        const newExercise = { id: baseId, name: baseName, variations: [] }; // Simplificado por ahora
        exerciseData[groupIndex].items.push(newExercise);

        // Ordenar
        exerciseData.sort((a, b) => a.group.localeCompare(b.group));
        exerciseData[groupIndex].items.sort((a, b) => a.name.localeCompare(b.name));
        console.log("Nuevo ejercicio añadido a la estructura.");

        // 4. Preparar el nuevo contenido para GitHub
        const newContent = JSON.stringify(exerciseData, null, 2); // Indentado para legibilidad
        const newContentBase64 = Buffer.from(newContent).toString('base64');

        // 5. Crear el commit en GitHub
        console.log("Intentando crear commit...");
        await octokit.repos.createOrUpdateFileContents({
            owner,
            repo,
            path: filePath,
            message: `feat: Añadir ejercicio global '${baseName}' via editor`, // Mensaje del commit
            content: newContentBase64,
            sha: fileData.sha, // MUY IMPORTANTE: Se necesita el SHA del archivo original para actualizarlo
            branch: branch,     // Asegúrate de hacer commit a la rama correcta
        });
        console.log("Commit creado en GitHub exitosamente.");

        // 6. Enviar respuesta de éxito
        res.send(`
            <h1>¡Ejercicio añadido a GitHub!</h1>
            <p>Se añadió <strong>${baseName}</strong> al archivo <code>${filePath}</code> en el repositorio ${repo}.</p>
            <p><strong>Próximos pasos:</strong></p>
            <ol>
                <li>Ve a tu computadora de desarrollo.</li>
                <li>Abre la terminal en tu proyecto Fitracker.</li>
                <li>Ejecuta <code>git pull</code> para descargar los cambios.</li>
                <li>Reconstruye y redespliega tu app Fitracker.</li>
            </ol>
            <a href="/">Añadir otro ejercicio</a>
            <style>body { font-family: sans-serif; padding: 20px; } h1 { color: green; } code { background-color: #eee; padding: 2px 5px; border-radius: 3px; }</style>
        `);

    } catch (error) {
        console.error("ERROR DETALLADO:", error);
        res.status(500).send(`
            <h1>Error al guardar en GitHub</h1>
            <p>Ocurrió un problema:</p>
            <pre>${error.message}</pre>
            <p>Revisa la consola del servidor (donde ejecutaste 'node server.js') para más detalles.</p>
            <a href="/">Volver a intentarlo</a>
            <style>body { font-family: sans-serif; padding: 20px; } h1 { color: red; } pre { background-color: #fdd; padding: 10px; border-radius: 5px; white-space: pre-wrap; word-wrap: break-word; }</style>
        `);
    }
});

// --- Iniciar el Servidor ---
app.listen(port, () => {
    console.log(`🚀 Servidor Editor escuchando en el puerto ${port}`);
    console.log(`   Accede localmente en http://localhost:${port}`);
    // Podrías añadir lógica para mostrar IPs locales si lo ejecutas localmente
});