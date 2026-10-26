const path = require('path')
const crypto = require('crypto')

const modrinth = require('./modrinthapi')
const loaders = require('./loaderresolver')
const packstore = require('./packstore')
const net = require('./netutil')

/**
 * Turns a pack definition (name, Minecraft version, loader, picked mods)
 * into a helios-core "server" entry: resolves the loader itself, looks up
 * every mod's real file on Modrinth, and hashes whatever helios-core needs
 * to validate downloads.
 */

const MOD_CONCURRENCY = 4

function isLegacyMinecraftVersion(mcVersion) {
    const [major, minor] = mcVersion.split('.').map(Number)
    return major === 1 && minor < 13
}

function slugify(name) {
    return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'pack'
}

function say(opts, msg) {
    if (typeof opts.onProgress === 'function') opts.onProgress(msg)
}

/**
 * @param {object} pack
 *   name, mcVersion, loader ('fabric'|'forge'|'neoforge'),
 *   loaderVersion (optional; latest/recommended is used if absent),
 *   mods: [{ projectId, versionId }]
 * @param {object} opts
 *   commonDir          launcher common directory (libraries/, versions/)
 *   launcherRoot       launcher data directory (tools/ and caches live here)
 *   getJavaExecutable  async () => path to java; only used for modern Forge/NeoForge
 *   forgeCliJarPath    optional override; otherwise ForgeCLI is fetched automatically
 *   serverId           optional; reuse to rebuild an existing pack in place
 *   onProgress         optional status callback
 * @returns {Promise<{server: object, loaderVersion: string}>}
 */
async function buildPack(pack, opts) {
    net.setHashCacheFile(path.join(opts.launcherRoot, 'dawn-hash-cache.json'))

    // --- 1. Loader ---
    let loaderModule
    let loaderVersion = pack.loaderVersion || null

    if (pack.loader === 'fabric') {
        loaderVersion = loaderVersion || await loaders.getLatestFabricLoaderVersion(pack.mcVersion)
        loaderModule = await loaders.resolveFabric(pack.mcVersion, loaderVersion, opts.commonDir, opts.onProgress)
    } else if (pack.loader === 'forge') {
        loaderVersion = loaderVersion || await loaders.getRecommendedForgeVersion(pack.mcVersion)
        if (isLegacyMinecraftVersion(pack.mcVersion)) {
            loaderModule = await loaders.resolveForgeLegacy(pack.mcVersion, loaderVersion, opts.commonDir, opts.onProgress)
        } else {
            const av = await loaders.getForgeArtifactVersion(pack.mcVersion, loaderVersion)
            loaderModule = await resolveModern({
                installerUrl: loaders.forgeInstallerUrl(av),
                loaderVersion,
                loaderName: 'Minecraft Forge'
            }, opts)
        }
    } else if (pack.loader === 'neoforge') {
        loaderVersion = loaderVersion || await loaders.getLatestNeoForgeVersion(pack.mcVersion)
        loaderModule = await resolveModern({
            installerUrl: loaders.neoForgeInstallerUrl(loaderVersion),
            loaderVersion,
            loaderName: 'NeoForge'
        }, opts)
    } else {
        throw new Error(`Unsupported loader: ${pack.loader}`)
    }

    // --- 2. Mods ---
    // Three kinds of entries: Modrinth ({projectId, versionId?}), direct links
    // ({url, fileName}, from imported packs) and local jars ({local, path, md5, size}).
    say(opts, 'Looking up mods on Modrinth...')
    const modType = pack.loader === 'fabric' ? 'FabricMod' : 'ForgeMod'
    const total = pack.mods.length
    let prepared = 0

    const modModules = await net.mapLimit(pack.mods, MOD_CONCURRENCY, async picked => {
        let module
        if (picked.local) {
            module = {
                id: `local:mod:${picked.md5}`,
                name: picked.title || picked.fileName.replace(/\.jar$/i, ''),
                type: modType,
                artifact: { size: picked.size, MD5: picked.md5, path: picked.path, url: 'https://localhost/local-mod' }
            }
        } else if (picked.url && !picked.projectId) {
            const { size, md5 } = await net.hashRemoteFileCached(picked.url)
            module = {
                id: `url:mod:${md5}`,
                name: (picked.title || picked.fileName || 'mod').replace(/\.jar$/i, ''),
                type: modType,
                artifact: { size, MD5: md5, url: picked.url }
            }
        } else {
            const version = picked.versionId
                ? await modrinth.getVersionById(picked.versionId)
                : (await modrinth.getModVersions(picked.projectId, pack.mcVersion, pack.loader))[0]
            if (!version) {
                throw new Error(`No version of mod ${picked.projectId} works with ${pack.loader} ${pack.mcVersion}.`)
            }
            // Modrinth gives sha1/sha512 only; helios-core wants MD5.
            const { size, md5 } = await net.hashRemoteFileCached(version.fileUrl)
            module = {
                id: `modrinth:${version.projectId}:${version.versionId}`,
                name: version.fileName.replace(/\.jar$/i, ''),
                type: modType,
                artifact: { size, MD5: md5, url: version.fileUrl }
            }
        }
        prepared++
        say(opts, `Preparing mods (${prepared}/${total})...`)
        return module
    })

    // --- 3. Server entry ---
    const server = {
        id: opts.serverId || `${slugify(pack.name)}-${crypto.randomBytes(2).toString('hex')}`,
        name: pack.name,
        description: `${pack.loader[0].toUpperCase()}${pack.loader.slice(1)} ${pack.mcVersion} - ${pack.mods.length} mod${pack.mods.length === 1 ? '' : 's'}`,
        icon: 'assets/images/dawn.png',
        version: '1.0.0',
        address: '',
        minecraftVersion: pack.mcVersion,
        mainServer: false,
        autoconnect: false,
        modules: [loaderModule, ...modModules]
    }

    return { server, loaderVersion }
}

async function resolveModern({ installerUrl, loaderVersion, loaderName }, opts) {
    if (typeof opts.getJavaExecutable !== 'function') {
        throw new Error('A Java executable is required to install Forge/NeoForge.')
    }
    const toolsDir = path.join(opts.launcherRoot, 'tools')
    const javaExecutable = await opts.getJavaExecutable()
    return loaders.resolveModernLoader({
        installerUrl,
        loaderVersion,
        loaderName,
        forgeCliJarPath: opts.forgeCliJarPath,
        toolsDir,
        javaExecutable,
        commonDir: opts.commonDir,
        onProgress: opts.onProgress
    })
}

/** Stores a pack's definition under a fresh share code. */
function sharePack(pack) {
    if (pack.mods.some(m => m.local)) {
        const err = new Error('This pack contains mod files from your own computer, so it cannot be shared by code. Only packs made of Modrinth/CurseForge mods can.')
        err.friendly = true
        return Promise.reject(err)
    }
    return packstore.savePack(pack)
}

/** Looks a share code up; resolves null when the code does not exist. */
function fetchSharedPack(code) {
    return packstore.loadPack(code)
}

module.exports = {
    buildPack,
    sharePack,
    fetchSharedPack,
    isLegacyMinecraftVersion
}
