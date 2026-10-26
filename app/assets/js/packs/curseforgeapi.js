const https = require('https')
const { getCurseForgeKey } = require('./packimport')

/**
 * CurseForge search + download lookups (the Core API; needs an API key,
 * see packimport.getCurseForgeKey). Mods whose authors turned off downloads
 * by third-party launchers are never offered.
 */

const GAME_ID = 432 // Minecraft
const CLASS_MOD = 6
const CLASS_MODPACK = 4471
const LOADER_TYPE = { forge: 1, fabric: 4, quilt: 5, neoforge: 6 }
const RELEASE_RANK = { 1: 0, 2: 1, 3: 2 } // release, beta, alpha

let launcherRoot = null
function setRoot(root) { launcherRoot = root }

function call(method, apiPath, body) {
    return new Promise((resolve, reject) => {
        const key = getCurseForgeKey(launcherRoot)
        if (!key) {
            const err = new Error('CurseForge needs an API key. Add your key to the launcher (curseforge-api-key.txt) to browse CurseForge.')
            err.friendly = true
            return reject(err)
        }
        const payload = body ? JSON.stringify(body) : null
        const headers = { 'x-api-key': key, 'Accept': 'application/json', 'User-Agent': 'DawnLauncher/1.0' }
        if (payload) {
            headers['Content-Type'] = 'application/json'
            headers['Content-Length'] = Buffer.byteLength(payload)
        }
        const req = https.request({ hostname: 'api.curseforge.com', path: apiPath, method, headers }, res => {
            let data = ''
            res.on('data', c => data += c)
            res.on('end', () => {
                if (res.statusCode === 401 || res.statusCode === 403) {
                    const err = new Error('CurseForge rejected the API key.')
                    err.friendly = true
                    return reject(err)
                }
                if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`CurseForge returned HTTP ${res.statusCode}.`))
                try { resolve(JSON.parse(data)) } catch (e) { reject(new Error('CurseForge sent an unreadable reply.')) }
            })
        })
        req.on('error', reject)
        req.setTimeout(30000, () => req.destroy(new Error('Timed out talking to CurseForge.')))
        if (payload) req.write(payload)
        req.end()
    })
}

/** @returns {Promise<{hits: Array, total: number}>} hit ids are "cf:<modId>" */
async function searchMods(query, mcVersion, loader, limit = 20, offset = 0, kind = 'mod') {
    const params = new URLSearchParams({
        gameId: String(GAME_ID),
        classId: String(kind === 'modpack' ? CLASS_MODPACK : CLASS_MOD),
        gameVersion: mcVersion,
        pageSize: String(limit),
        index: String(offset),
        sortField: '2', // popularity
        sortOrder: 'desc'
    })
    if (LOADER_TYPE[loader]) params.set('modLoaderType', String(LOADER_TYPE[loader]))
    if (query) params.set('searchFilter', query)
    const reply = await call('GET', `/v1/mods/search?${params.toString()}`)
    return {
        total: (reply.pagination && reply.pagination.totalCount) || 0,
        hits: (reply.data || [])
            .filter(m => m.allowModDistribution !== false)
            .map(m => ({
                id: `cf:${m.id}`,
                title: m.name,
                description: m.summary,
                iconUrl: m.logo && m.logo.thumbnailUrl,
                author: m.authors && m.authors[0] && m.authors[0].name
            }))
    }
}

/** Best downloadable file of a mod for a version + loader. */
async function getBestFile(modId, mcVersion, loader) {
    const params = new URLSearchParams({ gameVersion: mcVersion, pageSize: '50' })
    if (LOADER_TYPE[loader]) params.set('modLoaderType', String(LOADER_TYPE[loader]))
    const reply = await call('GET', `/v1/mods/${modId}/files?${params.toString()}`)
    const files = (reply.data || [])
        .filter(f => f.downloadUrl && /\.(jar|zip|mrpack)$/i.test(f.fileName))
        .sort((a, b) => (RELEASE_RANK[a.releaseType] ?? 3) - (RELEASE_RANK[b.releaseType] ?? 3) || new Date(b.fileDate) - new Date(a.fileDate))
    return files[0] || null
}

async function getTitles(modIds) {
    if (modIds.length === 0) return {}
    const reply = await call('POST', '/v1/mods', { modIds })
    const out = {}
    for (const m of reply.data || []) out[m.id] = m.name
    return out
}

/**
 * A mod plus its required dependencies, as direct-download pack entries.
 * @param {string} projectId "cf:<modId>"
 */
async function resolveWithDependencies(projectId, mcVersion, loader, have = new Set()) {
    const out = []
    const seen = new Set()

    async function visit(modId, isDependency, depth) {
        const key = `cf:${modId}`
        if (seen.has(key) || have.has(key)) return
        seen.add(key)
        const file = await getBestFile(modId, mcVersion, loader)
        if (!file) {
            if (isDependency) return // optional-ish: a missing dependency should not block the pack
            const err = new Error(`No version of this mod that can be downloaded by the launcher works with ${loader} ${mcVersion}. The author may have turned off launcher downloads.`)
            err.friendly = true
            throw err
        }
        out.push({ projectId: key, source: 'curseforge', url: file.downloadUrl, fileName: file.fileName, isDependency, modId })
        if (depth >= 6) return
        for (const dep of file.dependencies || []) {
            if (dep.relationType === 3) await visit(dep.modId, true, depth + 1)
        }
    }

    await visit(Number(String(projectId).replace('cf:', '')), false, 0)
    return out
}

/** Download link of a modpack's newest file. */
async function getModpackFile(projectId, mcVersion, loader) {
    const file = await getBestFile(Number(String(projectId).replace('cf:', '')), mcVersion, loader)
    if (!file) {
        const err = new Error('This modpack cannot be downloaded by the launcher (the author turned off third-party downloads, or no file matches your version).')
        err.friendly = true
        throw err
    }
    return { url: file.downloadUrl, fileName: file.fileName }
}

module.exports = { setRoot, searchMods, resolveWithDependencies, getTitles, getModpackFile }
