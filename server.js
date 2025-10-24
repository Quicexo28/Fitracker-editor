require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const { Octokit } = require('@octokit/rest');
const path = require('path');
const os = require('os'); // Para obtener la IP local

const app = express();
const port = process.env.PORT || 3000;

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
const owner = process.env.GITHUB_OWNER;
const repo = process.env.GITHUB_REPO;
const filePath = process.env.FILE_PATH;
const branch = process.env.COMMIT_BRANCH || 'main';

app.use(bodyParser.urlencoded({ extended: true })); // Para formularios complejos
app.use(express.static('public')); // Servir HTML, CSS, JS estáticos

// --- Helper: Obtener el JSON de ejercicios desde GitHub ---
async function getExerciseDataFromGithub() {
    console.log("GitHub API: Obteniendo", filePath);
    const { data: fileData } = await octokit.repos.getContent({
        owner, repo, path: filePath, ref: branch,
        headers: { 'If-None-Match': '' } // Evita caché
    });
    const content = Buffer.from(fileData.content, 'base64').toString('utf-8');
    console.log("GitHub API: Archivo obtenido y decodificado.");
    return { exercises: JSON.parse(content), sha: fileData.sha };
}

// --- Ruta API para obtener la lista (sin cambios) ---
app.get('/api/exercises', async (req, res) => {
    try {
        const data = await getExerciseDataFromGithub();
        res.json(data);
    } catch (error) {
        console.error("API Error: /api/exercises:", error);
        res.status(500).json({ error: 'No se pudo cargar la lista de ejercicios.', details: error.message });
    }
});

// --- Ruta para mostrar el formulario (sin cambios, el HTML se actualiza) ---
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- Ruta para Guardar/Actualizar Ejercicio ---
app.post('/save-exercise', async (req, res) => {
    const { editMode, originalBaseId, fileSha, group, baseId, baseName, variations } = req.body;
    console.log("Recibido para guardar:", JSON.stringify(req.body, null, 2)); // Log detallado

    // --- Validación básica ---
    if (!group || !baseId || !baseName || !/^[a-z0-9-]+$/.test(baseId) || !fileSha) {
        return res.status(400).send('Datos incompletos, ID base inválido o falta SHA.');
    }

    try {
        // Obtener datos actuales frescos justo antes de modificar
        const { exercises: currentExerciseData, sha: currentSha } = await getExerciseDataFromGithub();
        // ¡Importante! Comprobar si el SHA coincide con el que tenía el cliente al cargar la página
        if (currentSha !== fileSha) {
            console.warn("Conflicto de SHA detectado. El archivo cambió en GitHub.");
            return res.status(409).send(`
                <h1>Conflicto detectado</h1>
                <p>El archivo de ejercicios en GitHub ha cambiado desde que cargaste esta página.</p>
                <p>Por favor, <a href="/">recarga la página</a> para obtener la última versión y vuelve a introducir tus cambios.</p>
                <style>body{font-family:sans-serif;padding:20px;} h1{color:orange;}</style>
            `);
        }
        console.log("SHA verificado, procediendo con la modificación.");

        // --- Lógica de Validación de IDs (más robusta) ---
        const allIds = new Set();
        currentExerciseData.forEach(g => g.items.forEach(item => {
            if (!editMode || item.id !== originalBaseId) { // Excluir el original al editar
                allIds.add(item.id);
                item.variations?.forEach(v => {
                    allIds.add(v.id);
                    v.subVariations?.forEach(sv => {
                        allIds.add(sv.id);
                        sv.executionTypes?.forEach(et => allIds.add(et.id));
                    });
                });
            }
        }));

        if (allIds.has(baseId)) return res.status(400).send(`Error: El ID Base '${baseId}' ya existe.`);

        const processVariations = (levelData, levelName, parentId) => {
            if (!levelData) return [];
            const idsInLevel = new Set();
            return levelData.map((item, index) => {
                const itemId = item.id ? item.id.trim() : '';
                const itemName = item.name ? item.name.trim() : '';
                 if (!itemId || !/^[a-z0-9-]+$/.test(itemId)) throw new Error(`ID de ${levelName} inválido.`);
                 if (!itemName) throw new Error(`Nombre de ${levelName} vacío.`);
                 if (allIds.has(itemId) || idsInLevel.has(itemId)) throw new Error(`ID de ${levelName} '${itemId}' duplicado.`);
                 idsInLevel.add(itemId);
                 allIds.add(itemId); // Añadir a la validación global

                const processedItem = {
                    id: itemId,
                    name: itemName,
                    imageUrl: item.imageUrl || undefined,
                    isUnilateral: item.isUnilateral === 'true',
                };
                // Procesar siguiente nivel recursivamente
                if (levelName === 'Variación' && item.subVariations) {
                    processedItem.subVariations = processVariations(item.subVariations, 'Sub-Variación', itemId);
                     if (processedItem.subVariations.length === 0) delete processedItem.subVariations;
                }
                if (levelName === 'Sub-Variación' && item.executionTypes) {
                    processedItem.executionTypes = processVariations(item.executionTypes, 'Tipo Ejecución', itemId);
                     if (processedItem.executionTypes.length === 0) delete processedItem.executionTypes;
                }
                return processedItem;
            }).filter(Boolean); // Eliminar posibles nulos si la validación falla (aunque lanzamos error)
        };

        let processedVariations = [];
        try {
            processedVariations = processVariations(variations, 'Variación', baseId);
        } catch (error) {
            return res.status(400).send(`Error de Validación: ${error.message}`);
        }
        // --- Fin Validación ---

        // Construir el objeto completo del ejercicio
        const exerciseObject = {
            id: baseId,
            name: baseName,
            variations: processedVariations,
        };
        if (exerciseObject.variations.length === 0) delete exerciseObject.variations;
        else exerciseObject.variations.sort((a, b) => a.name.localeCompare(b.name)); // Ordenar variaciones

        let commitMessage = '';
        let successMessage = '';

        if (editMode === 'true' && originalBaseId) {
            // --- MODO EDICIÓN ---
            let foundAndUpdated = false;
            for (let i = 0; i < currentExerciseData.length; i++) {
                const group = currentExerciseData[i];
                const itemIndex = group.items.findIndex(item => item.id === originalBaseId);
                if (itemIndex !== -1) {
                    // Simple reemplazo por ahora. Una fusión más compleja podría hacerse.
                    group.items[itemIndex] = exerciseObject;
                    // TODO: Mover a otro grupo si req.body.group es diferente group.group
                    foundAndUpdated = true;
                    break;
                }
            }
             if (!foundAndUpdated) throw new Error(`No se encontró el ejercicio original '${originalBaseId}'.`);
            commitMessage = `feat: Actualizar ejercicio global '${baseName}' via editor`;
            successMessage = `Ejercicio <strong>${baseName}</strong> actualizado.`;

        } else {
            // --- MODO AÑADIR NUEVO ---
            let groupIndex = currentExerciseData.findIndex(g => g.group.toLowerCase() === group.toLowerCase());
            if (groupIndex === -1) {
                currentExerciseData.push({ group: group, items: [] });
                groupIndex = currentExerciseData.length - 1;
            }
            currentExerciseData[groupIndex].items.push(exerciseObject);
            commitMessage = `feat: Añadir ejercicio global '${baseName}' via editor`;
            successMessage = `Ejercicio <strong>${baseName}</strong> añadido al grupo <strong>${group}</strong>.`;
        }

        // Ordenar todo antes de guardar
        currentExerciseData.sort((a, b) => a.group.localeCompare(b.group));
        currentExerciseData.forEach(g => g.items.sort((a, b) => a.name.localeCompare(b.name)));
        console.log("Estructura de datos actualizada.");

        // Preparar y enviar a GitHub
        const newContent = JSON.stringify(currentExerciseData, null, 2); // Indentado
        const newContentBase64 = Buffer.from(newContent).toString('base64');

        console.log("Intentando crear commit en GitHub...");
        await octokit.repos.createOrUpdateFileContents({
            owner, repo, path: filePath,
            message: commitMessage,
            content: newContentBase64,
            sha: currentSha, // Usa el SHA obtenido al inicio
            branch: branch,
        });
        console.log("Commit creado en GitHub exitosamente.");

        // Enviar respuesta de éxito
        res.send(`
            <!DOCTYPE html><html lang="es"><head><title>Éxito</title><style>/* Estilos básicos */</style></head>
            <body>
                <h1 class="success">¡Guardado con éxito!</h1>
                <p>${successMessage}</p>
                <p>El archivo <code>${filePath}</code> ha sido actualizado en GitHub.</p>
                <p><strong>Importante:</strong> Haz <code>git pull</code> en tu proyecto Fitracker y reconstruye/redespliega la app para ver los cambios.</p>
                <a href="/">Volver al Editor</a>
            </body></html>
        `);

    } catch (error) {
        console.error("ERROR DETALLADO al guardar:", error);
        res.status(500).send(/* ... mensaje de error del servidor ... */);
    }
});

// --- Iniciar el Servidor ---
app.listen(port, () => {
    console.log(`🚀 Servidor Editor escuchando en el puerto ${port}`);
    console.log(`   Accede localmente en http://localhost:${port}`);
    // Podrías añadir lógica para mostrar IPs locales
});