const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const https = require('https')
const AdmZip = require('adm-zip')

const net = require('./netutil')

/**
 * Imports modpack archives into pack definitions the launcher can build:
 *
 *   - Modrinth packs (.mrpack): modrinth.index.json lists every file with a
 *     download URL. Mods hosted on Modrinth become ordinary Modrinth entries
 *     (so the result can still be shared by code); anything else keeps its URL.
 *   - CurseForge packs (.zip with manifest.json): files are looked up through
 *     the CurseForge API, which needs an API key (see getCurseForgeKey).
 *   - Plain zips of mod .jar files: the jars are copied into the launcher's
 *     own mod folders. The player picks the Minecraft version and loader.
 *
 * "overrides" folders (configs, scripts, etc.) are copied into the pack's
 * instance folder; they are not tracked afterwards, so players can edit them.
 */

const LOADER_KEYS = {
    'fabric-loader': 'fabric',
    forge: 'forge',
    neoforge: 'neoforge'
}

function slugify(name) {
    return String(name || 'pack').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'pack'
}

/** Resolves a zip entry name inside dest, refusing anything that escapes it. */
function safeJoin(dest, entryName) {
    const target = path.resolve(dest, entryName)
    const root = path.resolve(dest) + path.sep
    if (!target.startsWith(root)) {
        throw new Error(`Unsafe path in pack: ${entryName}`)
    }
    return target
}

/* ------------------------------------------------------------------ */
/* Detecting + reading                                                 */
/* ------------------------------------------------------------------ */

/**
 * Looks inside an archive and says what it is.
 * @returns {{kind: 'mrpack'|'curseforge'|'jars', name: string, mcVersion?: string, loader?: string, loaderVersion?: string, modCount: number}}
 */
function inspectArchive(filePath) {
    let zip
    try {
        zip = new AdmZip(filePath)
    } catch (err) {
        throw new Error('That file could not be opened as a zip archive.')
    }

    if (zip.getEntry('modrinth.index.json')) {
        const def = parseMrpack(zip, filePath)
        return { kind: 'mrpack', name: def.name, mcVersion: def.mcVersion, loader: def.loader, loaderVersion: def.loaderVersion, modCount: def.mods.length }
    }

    if (zip.getEntry('manifest.json')) {
        const manifest = JSON.parse(zip.readAsText('manifest.json'))
        const cf = parseCurseForgeManifest(manifest, filePath)
        return { kind: 'curseforge', name: cf.name, mcVersion: cf.mcVersion, loader: cf.loader, loaderVersion: cf.loaderVersion, modCount: cf.fileIds.length }
    }

    const jars = zip.getEntries().filter(e => !e.isDirectory && /\.jar$/i.test(e.entryName))
    if (jars.length > 0) {
        return { kind: 'jars', name: path.basename(filePath).replace(/\.zip$/i, ''), modCount: jars.length }
    }

    throw new Error('This zip is not a Modrinth pack, a CurseForge pack, or a folder of mod .jar files.')
}

/* ---- Modrinth (.mrpack) ---- */

const MODRINTH_CDN = /^https?:\/\/cdn\.modrinth\.com\/data\/([^/]+)\/versions\/([^/]+)\//

function parseMrpack(zip, filePath) {
    const index = JSON.parse(zip.readAsText('modrinth.index.json'))
    const deps = index.dependencies || {}

    const mcVersion = deps.minecraft
    if (!mcVersion) throw new Error('This Modrinth pack does not say which Minecraft version it needs.')

    let loader = null
    let loaderVersion = null
    for (const [key, value] of Object.entries(deps)) {
        if (LOADER_KEYS[key]) {
            loader = LOADER_KEYS[key]
            loaderVersion = value
        }
    }
    if (!loader) {
        if (deps['quilt-loader']) throw new Error('Quilt packs are not supported yet. Only Fabric, Forge and NeoForge packs can be imported.')
        throw new Error('This Modrinth pack does not use a supported mod loader (Fabric, Forge or NeoForge).')
    }

    const mods = []
    const extras = []
    for (const file of index.files || []) {
        if (file.env && file.env.client === 'unsupported') continue // server-only
        const url = (file.downloads || [])[0]
        if (!url) continue
        const fileName = path.basename(file.path)

        if (/^mods\//i.test(file.path) && /\.jar$/i.test(fileName)) {
            const m = MODRINTH_CDN.exec(url)
            if (m) {
                mods.push({ projectId: m[1], versionId: m[2], title: fileName.replace(/\.jar$/i, ''), fileName })
            } else {
                mods.push({ url, fileName, title: fileName.replace(/\.jar$/i, ''), size: file.fileSize || null })
            }
        } else {
            extras.push({ path: file.path, url })
        }
    }

    return {
        name: index.name || path.basename(filePath, path.extname(filePath)),
        mcVersion,
        loader,
        loaderVersion,
        mods,
        extras,
        overrideFolders: ['overrides', 'client-overrides']
    }
}

/* ---- CurseForge (.zip with manifest.json) ---- */

function parseCurseForgeManifest(manifest, filePath) {
    const mc = manifest.minecraft || {}
    if (!mc.version) throw new Error('This CurseForge pack does not say which Minecraft version it needs.')

    const loaders = mc.modLoaders || []
    const primary = loaders.find(l => l.primary) || loaders[0]
    if (!primary || !primary.id) throw new Error('This CurseForge pack does not name a mod loader.')

    const dash = primary.id.indexOf('-')
    const loaderName = primary.id.slice(0, dash).toLowerCase()
    const loaderVersion = primary.id.slice(dash + 1)
    if (!['forge', 'neoforge', 'fabric'].includes(loaderName)) {
        throw new Error(`The mod loader "${loaderName}" is not supported yet. Only Fabric, Forge and NeoForge packs can be imported.`)
    }

    return {
        name: manifest.name || path.basename(filePath, path.extname(filePath)),
        mcVersion: mc.version,
        loader: loaderName,
        loaderVersion,
        fileIds: (manifest.files || []).filter(f => f.required !== false).map(f => ({ projectId: f.projectID, fileId: f.fileID })),
        overrides: manifest.overrides || 'overrides'
    }
}

/**
 * The CurseForge API needs a key issued by CurseForge. Put it in a file
 * named curseforge-api-key.txt in the launcher's data folder.
 */
/** Removes whitespace, a BOM and stray quotes or a "key=" prefix from a pasted key. */
function cleanKey(raw) {
    raw = String(raw).replace(/^\uFEFF/, '').trim()
    // The key was saved together with its JSON wrapper, like { "key": "..." }.
    if (raw.startsWith('{')) {
        try { raw = String(JSON.parse(raw).key || '') } catch (err) {
            const m = /"key"\s*:\s*"([^"]+)"/.exec(raw)
            raw = m ? m[1] : raw
        }
    }
    return String(raw).replace(/^\uFEFF/, '').trim().replace(/^[\w-]*\s*[=:]\s*/, '').replace(/^["']|["']$/g, '').trim()
}

function getCurseForgeKey(launcherRoot) {
    // 1. A key baked into the build (app/assets/js/packs/curseforge-key.json).
    try {
        const bundled = require('./curseforge-key.json')
        if (bundled && typeof bundled.key === 'string' && cleanKey(bundled.key)) return cleanKey(bundled.key)
    } catch (err) {
        // not bundled; fall through
    }
    // 2. A key file the player saved themselves.
    try {
        // also accept the double extension Windows adds when extensions are hidden
        const file = ['curseforge-api-key.txt', 'curseforge-api-key.txt.txt', 'curseforge-api-key']
            .map(n => path.join(launcherRoot, n)).find(f => fs.existsSync(f))
        if (file) return cleanKey(fs.readFileSync(file, 'utf-8')) || null
    } catch (err) {
        // fall through
    }
    return process.env.CURSEFORGE_API_KEY || null
}

function curseForgePost(apiPath, body, key) {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify(body)
        const req = https.request({
            hostname: 'api.curseforge.com',
            path: apiPath,
            method: 'POST',
            headers: {
                'x-api-key': key,
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'Content-Length': Buffer.byteLength(payload),
                'User-Agent': 'DawnLauncher/1.0'
            }
        }, res => {
            let data = ''
            res.on('data', c => data += c)
            res.on('end', () => {
                if (res.statusCode === 403 || res.statusCode === 401) {
                    reject(new Error(`CurseForge rejected the API key (HTTP ${res.statusCode}, key length ${String(key).length}, starts with "${String(key).slice(0, 4)}"). A valid key is about 60 characters and starts with $2a$10$. Check you copied the whole key from console.curseforge.com.`))
                } else if (res.statusCode < 200 || res.statusCode >= 300) {
                    reject(new Error(`CurseForge returned HTTP ${res.statusCode}.`))
                } else {
                    try { resolve(JSON.parse(data)) } catch (err) { reject(new Error('CurseForge sent an unreadable reply.')) }
                }
            })
        })
        req.on('error', reject)
        req.setTimeout(30000, () => req.destroy(new Error('Timed out talking to CurseForge.')))
        req.write(payload)
        req.end()
    })
}

/** Turns CurseForge file ids into direct-download mod entries. */
async function resolveCurseForgeFiles(fileIds, launcherRoot, onProgress) {
    const key = getCurseForgeKey(launcherRoot)
    if (!key) {
        throw new Error(`CurseForge packs need a CurseForge API key. No key was found. Save it in a file named curseforge-api-key.txt in exactly this folder: ${launcherRoot}  (Modrinth packs and plain mod zips work without it.)`)
    }

    const mods = []
    const blocked = []
    for (let i = 0; i < fileIds.length; i += 50) {
        if (typeof onProgress === 'function') onProgress(`Looking up CurseForge mods (${Math.min(i + 50, fileIds.length)}/${fileIds.length})...`)
        const batch = fileIds.slice(i, i + 50)
        const reply = await curseForgePost('/v1/mods/files', { fileIds: batch.map(f => f.fileId) }, key)
        const byId = new Map((reply.data || []).map(f => [f.id, f]))
        for (const ref of batch) {
            const f = byId.get(ref.fileId)
            if (!f) {
                blocked.push(`file ${ref.fileId}`)
            } else if (!f.downloadUrl) {
                // The author has switched off downloads by third-party launchers.
                blocked.push(f.fileName || `file ${ref.fileId}`)
            } else if (/\.jar$/i.test(f.fileName)) {
                mods.push({ url: f.downloadUrl, fileName: f.fileName, title: f.fileName.replace(/\.jar$/i, '') })
            }
        }
    }

    if (blocked.length > 0) {
        const shown = blocked.slice(0, 6).join(', ')
        throw new Error(`${blocked.length} mod${blocked.length === 1 ? '' : 's'} in this pack can only be downloaded from the CurseForge website (the authors have turned off launcher downloads): ${shown}${blocked.length > 6 ? ', ...' : ''}. Download them from CurseForge yourself, put them in a zip, and import that zip instead.`)
    }
    return mods
}

/* ---- Plain zips of .jar files ---- */

/**
 * Copies every .jar in the zip into the launcher's own mod folder (where the
 * launch code looks for them) and returns local mod entries.
 */
function extractJars(zip, commonDir, loader) {
    const root = loader === 'fabric'
        ? path.join(commonDir, 'mods', 'fabric', 'local')
        : path.join(commonDir, 'modstore', 'local')
    fs.mkdirSync(root, { recursive: true })

    const mods = []
    for (const entry of zip.getEntries()) {
        if (entry.isDirectory || !/\.jar$/i.test(entry.entryName)) continue
        const data = entry.getData()
        const md5 = crypto.createHash('md5').update(data).digest('hex')
        const base = path.basename(entry.entryName)
        const fileName = `${md5.slice(0, 8)}-${base}`
        fs.writeFileSync(path.join(root, fileName), data)
        mods.push({
            local: true,
            fileName: base,
            title: base.replace(/\.jar$/i, ''),
            path: `local/${fileName}`,
            size: data.length,
            md5
        })
    }
    return mods
}

/* ------------------------------------------------------------------ */
/* Overrides + extra files                                             */
/* ------------------------------------------------------------------ */

/** Copies override folders from the zip into the pack's instance folder. */
function applyOverrides(zip, folders, destDir) {
    fs.mkdirSync(destDir, { recursive: true })
    let copied = 0
    for (const entry of zip.getEntries()) {
        if (entry.isDirectory) continue
        for (const folder of folders) {
            const prefix = folder.replace(/\/?$/, '/')
            if (entry.entryName.startsWith(prefix)) {
                const rel = entry.entryName.slice(prefix.length)
                if (!rel) continue
                const target = safeJoin(destDir, rel)
                fs.mkdirSync(path.dirname(target), { recursive: true })
                fs.writeFileSync(target, entry.getData())
                copied++
                break
            }
        }
    }
    return copied
}

/** Downloads non-mod files (shaders, resource packs...) listed by a pack. */
async function downloadExtras(extras, destDir, onProgress) {
    let done = 0
    await net.mapLimit(extras, 3, async extra => {
        const target = safeJoin(destDir, extra.path)
        await net.downloadToFile(extra.url, target)
        done++
        if (typeof onProgress === 'function') onProgress(`Downloading extra files (${done}/${extras.length})...`)
    })
}

/* ------------------------------------------------------------------ */
/* Main entry point                                                    */
/* ------------------------------------------------------------------ */

/**
 * Reads an archive and returns what the launcher needs to build it.
 *
 * @param {string} filePath
 * @param {object} opts
 *   launcherRoot, commonDir          launcher folders
 *   mcVersion, loader                required only for plain mod zips
 *   onProgress                       optional status callback
 * @returns {Promise<{definition: object, serverId: string, finish: function}>}
 *   `finish(instanceDir)` copies overrides/extras into the pack's instance
 *   folder once the pack's id is final; it returns a short summary string.
 */
async function prepareImport(filePath, opts) {
    const zip = new AdmZip(filePath)
    const info = inspectArchive(filePath)
    const say = opts.onProgress || (() => {})
    let definition
    let overrideFolders = []
    let extras = []

    if (info.kind === 'mrpack') {
        const parsed = parseMrpack(zip, filePath)
        definition = { name: parsed.name, mcVersion: parsed.mcVersion, loader: parsed.loader, loaderVersion: parsed.loaderVersion, mods: parsed.mods }
        overrideFolders = parsed.overrideFolders
        extras = parsed.extras
    } else if (info.kind === 'curseforge') {
        const manifest = JSON.parse(zip.readAsText('manifest.json'))
        const cf = parseCurseForgeManifest(manifest, filePath)
        const mods = await resolveCurseForgeFiles(cf.fileIds, opts.launcherRoot, say)
        definition = { name: cf.name, mcVersion: cf.mcVersion, loader: cf.loader, loaderVersion: cf.loaderVersion, mods }
        overrideFolders = [cf.overrides]
    } else {
        if (!opts.mcVersion || !/^\d+\.\d+(\.\d+)?$/.test(opts.mcVersion)) throw new Error('Enter the Minecraft version these mods are for, like 1.20.1.')
        if (!opts.loader) throw new Error('Choose which mod loader these mods are for.')
        say('Copying mods...')
        const mods = extractJars(zip, opts.commonDir, opts.loader)
        definition = { name: info.name, mcVersion: opts.mcVersion, loader: opts.loader, loaderVersion: null, mods }
    }

    if (definition.mods.length === 0) {
        throw new Error('No mods were found in this pack.')
    }

    const serverId = `${slugify(definition.name)}-${crypto.randomBytes(2).toString('hex')}`

    async function finish(instanceDir) {
        const notes = []
        if (overrideFolders.length > 0) {
            const copied = applyOverrides(zip, overrideFolders, instanceDir)
            if (copied > 0) notes.push(`${copied} config/data file${copied === 1 ? '' : 's'} copied`)
        }
        if (extras.length > 0) {
            await downloadExtras(extras, instanceDir, say)
            notes.push(`${extras.length} extra file${extras.length === 1 ? '' : 's'} downloaded`)
        }
        return notes.join(', ')
    }

    return { definition, serverId, finish, kind: info.kind }
}

module.exports = {
    getCurseForgeKey,
    inspectArchive,
    prepareImport,
    // exposed for testing
    parseMrpack,
    parseCurseForgeManifest,
    extractJars,
    applyOverrides,
    safeJoin
}
