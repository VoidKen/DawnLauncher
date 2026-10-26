const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { spawn } = require('child_process')

const net = require('./netutil')

/**
 * Resolves mod loaders (Fabric / Forge / NeoForge) into the module trees
 * helios-core's distribution format expects, so the launcher can build a
 * distribution itself instead of fetching one from a hosted distribution.json.
 *
 * Every module returned here carries artifact.{size, MD5, url}, because
 * helios-core validates every module (including loaders) by MD5.
 */

const HASH_CONCURRENCY = 6

function md5OfString(text) {
    return crypto.createHash('md5').update(Buffer.from(text, 'utf-8')).digest('hex')
}

function say(onProgress, msg) {
    if (typeof onProgress === 'function') onProgress(msg)
}

/* ------------------------------------------------------------------ */
/* Fabric                                                              */
/* ------------------------------------------------------------------ */

async function getLatestFabricLoaderVersion(mcVersion) {
    const loaders = await net.getJson(`https://meta.fabricmc.net/v2/versions/loader/${mcVersion}`)
    const stable = loaders.find(l => l.loader.stable) || loaders[0]
    if (!stable) {
        throw new Error(`Fabric does not support Minecraft ${mcVersion}.`)
    }
    return stable.loader.version
}

/**
 * Fabric publishes a full launch profile, so no installer is needed.
 * Layout produced (matches what helios-core expects for Type.Fabric):
 *   Fabric (the loader jar)
 *     ├─ Library x N         (intermediary, asm, ...)
 *     └─ VersionManifest     (the profile json, stored in versions/<id>/)
 */
async function resolveFabric(mcVersion, loaderVersion, commonDir, onProgress) {
    say(onProgress, 'Fetching Fabric launch profile...')
    const profileUrl = `https://meta.fabricmc.net/v2/versions/loader/${mcVersion}/${loaderVersion}/profile/json`
    const profileText = await net.getText(profileUrl)
    const profile = JSON.parse(profileText)

    const libs = await mapLibraries(profile.libraries, onProgress, 'Fabric')

    const loaderIdx = libs.findIndex(l => l.id.startsWith('net.fabricmc:fabric-loader:'))
    if (loaderIdx === -1) {
        throw new Error('Fabric profile did not include the loader library.')
    }
    const loaderLib = libs.splice(loaderIdx, 1)[0]

    // helios-core expects the manifest on disk at versions/<id>/<id>.json.
    const manifestPath = path.join(commonDir, 'versions', profile.id, `${profile.id}.json`)
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true })
    fs.writeFileSync(manifestPath, profileText)

    return {
        id: loaderLib.id,
        name: 'Fabric Loader',
        type: 'Fabric',
        artifact: loaderLib.artifact,
        subModules: [
            ...libs.map(l => ({ id: l.id, name: l.name, type: 'Library', artifact: l.artifact })),
            {
                id: profile.id,
                name: 'Fabric Version Manifest',
                type: 'VersionManifest',
                artifact: {
                    size: Buffer.byteLength(profileText),
                    MD5: md5OfString(profileText),
                    url: profileUrl
                }
            }
        ]
    }
}

/**
 * Turns a version-json library list into resolved {id, name, artifact}
 * entries with hashes. Libraries whose files cannot be found anywhere are
 * dropped (they are normally covered by Mojang's own library list).
 */
async function mapLibraries(libraries, onProgress, label, opts = {}) {
    const skip = opts.skip || (() => false)
    const seen = new Set()
    const wanted = []
    for (const lib of libraries || []) {
        if (!lib.name || seen.has(lib.name) || skip(lib) || lib.natives) continue
        seen.add(lib.name)
        wanted.push(lib)
    }

    let done = 0
    const resolved = await net.mapLimit(wanted, HASH_CONCURRENCY, async lib => {
        const entry = await resolveLibrary(lib, opts.commonDir)
        done++
        say(onProgress, `Preparing ${label} libraries (${done}/${wanted.length})...`)
        return entry
    })
    return resolved.filter(Boolean)
}

const FALLBACK_REPOS = [
    'https://libraries.minecraft.net/',
    'https://maven.minecraftforge.net/',
    'https://repo1.maven.org/maven2/',
    'https://maven.fabricmc.net/'
]

function normalizeRepoUrl(url) {
    if (!url) return null
    let u = url.replace(/^http:\/\//, 'https://')
    u = u.replace('files.minecraftforge.net/maven', 'maven.minecraftforge.net')
    return u.endsWith('/') ? u : u + '/'
}

function mavenPathOf(name) {
    // group:artifact:version[:classifier][@ext]
    const [coords, ext = 'jar'] = name.split('@')
    const [group, artifact, version, classifier] = coords.split(':')
    return `${group.replace(/\./g, '/')}/${artifact}/${version}/${artifact}-${version}${classifier ? '-' + classifier : ''}.${ext}`
}

async function resolveLibrary(lib, commonDir) {
    const mavenPath = mavenPathOf(lib.name)
    const art = lib.downloads && lib.downloads.artifact
    const relPath = (art && art.path) || mavenPath
    const entry = { id: lib.name, name: lib.name.split(':')[1] || lib.name, artifact: {} }
    if (relPath !== mavenPath) {
        entry.artifact.path = relPath
    }

    // 1. Already on disk (e.g. generated by the Forge installer).
    if (commonDir) {
        const local = path.join(commonDir, 'libraries', relPath)
        if (fs.existsSync(local)) {
            const { size, md5 } = net.hashLocalFile(local)
            entry.artifact.size = size
            entry.artifact.MD5 = md5
            entry.artifact.url = (art && art.url) || ''
            return entry
        }
    }

    // 2. Hash-bearing metadata (Fabric supplies md5 + size directly).
    if (lib.md5 && lib.size && lib.url) {
        entry.artifact.size = lib.size
        entry.artifact.MD5 = lib.md5
        entry.artifact.url = normalizeRepoUrl(lib.url) + relPath
        return entry
    }

    // 3. Find a working download URL and hash it.
    const candidates = []
    if (art && art.url) candidates.push(art.url)
    const repo = normalizeRepoUrl(lib.url)
    if (repo) candidates.push(repo + relPath)
    for (const base of FALLBACK_REPOS) candidates.push(base + relPath)

    for (const url of [...new Set(candidates)]) {
        try {
            const { size, md5 } = await net.hashRemoteFileCached(url)
            entry.artifact.size = size
            entry.artifact.MD5 = md5
            entry.artifact.url = url
            return entry
        } catch (err) {
            // Try the next candidate.
        }
    }
    return null
}

/* ------------------------------------------------------------------ */
/* Forge                                                               */
/* ------------------------------------------------------------------ */

async function getRecommendedForgeVersion(mcVersion) {
    const promos = (await net.getJson('https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json')).promos
    const version = promos[`${mcVersion}-recommended`] || promos[`${mcVersion}-latest`]
    if (!version) {
        throw new Error(`Forge has no builds for Minecraft ${mcVersion}.`)
    }
    return version
}

/**
 * Forge's maven folder is "<mc>-<forge>" for most versions, but
 * "<mc>-<forge>-<mc>" for a few old ones (1.7.10, 1.8.9, ...).
 */
async function getForgeArtifactVersion(mcVersion, forgeVersion) {
    const base = 'https://maven.minecraftforge.net/net/minecraftforge/forge/'
    for (const av of [`${mcVersion}-${forgeVersion}`, `${mcVersion}-${forgeVersion}-${mcVersion}`]) {
        if (await net.urlExists(`${base}${av}/forge-${av}-installer.jar`)) {
            return av
        }
    }
    throw new Error(`Could not find Forge ${forgeVersion} for Minecraft ${mcVersion} on Forge's maven.`)
}

function forgeInstallerUrl(artifactVersion) {
    return `https://maven.minecraftforge.net/net/minecraftforge/forge/${artifactVersion}/forge-${artifactVersion}-installer.jar`
}

/** Mirrors helios-core's own check for which launch style a Forge build uses. */
function isForgeGradle3(mcVersion, artifactVersion) {
    const [, minor] = mcVersion.split('.').map(Number)
    if (minor >= 13) return true
    try {
        const maxFG2 = [14, 23, 5, 2847]
        const verSplit = artifactVersion.split('-')[1].split('.').map(Number)
        for (let i = 0; i < maxFG2.length; i++) {
            if (verSplit[i] > maxFG2[i]) return true
            if (verSplit[i] < maxFG2[i]) return false
        }
        return false
    } catch (err) {
        return true
    }
}

/**
 * Forge for Minecraft < 1.13 needs no installer: the "universal" jar embeds
 * the same version.json vanilla uses. Builds newer than 14.23.5.2847
 * (1.12.2) use helios's manifest style, which this also covers.
 */
async function resolveForgeLegacy(mcVersion, forgeVersion, commonDir, onProgress) {
    const StreamZip = require('node-stream-zip')

    say(onProgress, 'Locating Forge...')
    const av = await getForgeArtifactVersion(mcVersion, forgeVersion)
    const jarName = `forge-${av}-universal.jar`
    const url = `https://maven.minecraftforge.net/net/minecraftforge/forge/${av}/${jarName}`

    say(onProgress, `Downloading Forge ${forgeVersion}...`)
    const tempPath = path.join(os.tmpdir(), `dawn-${jarName}`)
    await net.downloadToFile(url, tempPath)

    let versionJsonText
    const zip = new StreamZip.async({ file: tempPath })
    try {
        versionJsonText = (await zip.entryData('version.json')).toString('utf-8')
    } finally {
        await zip.close()
    }
    const versionJson = JSON.parse(versionJsonText)
    const { size, md5 } = net.hashLocalFile(tempPath)
    fs.unlinkSync(tempPath)

    const libs = await mapLibraries(versionJson.libraries, onProgress, 'Forge', {
        commonDir,
        skip: lib => /^net\.minecraftforge:(forge|minecraftforge):/.test(lib.name)
    })

    const forgeModule = {
        id: `net.minecraftforge:forge:${av}:universal`,
        name: 'Minecraft Forge',
        type: 'ForgeHosted',
        artifact: { size, MD5: md5, url },
        subModules: libs.map(l => ({ id: l.id, name: l.name, type: 'Library', artifact: l.artifact }))
    }

    if (isForgeGradle3(mcVersion, av)) {
        const manifestPath = path.join(commonDir, 'versions', versionJson.id, `${versionJson.id}.json`)
        fs.mkdirSync(path.dirname(manifestPath), { recursive: true })
        fs.writeFileSync(manifestPath, versionJsonText)
        forgeModule.subModules.push({
            id: versionJson.id,
            name: 'Forge Version Manifest',
            type: 'VersionManifest',
            artifact: { size: Buffer.byteLength(versionJsonText), MD5: md5OfString(versionJsonText), url: '' }
        })
    }

    return forgeModule
}

/* ------------------------------------------------------------------ */
/* NeoForge                                                            */
/* ------------------------------------------------------------------ */

/**
 * NeoForge numbers builds by Minecraft version: 1.21.1 -> 21.1.x, 1.21 ->
 * 21.0.x. (NeoForge for 1.20.1 was a differently-packaged Forge fork and
 * isn't handled here; use Forge for 1.20.1.)
 */
async function getLatestNeoForgeVersion(mcVersion) {
    const [major, minor, patch] = mcVersion.split('.').map(Number)
    if (major !== 1 || minor < 20 || (minor === 20 && !(patch >= 2))) {
        throw new Error('NeoForge is only supported here for Minecraft 1.20.2 and newer. For 1.20.1, choose Forge.')
    }
    const prefix = `${minor}.${patch || 0}.`
    const xml = await net.getText('https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml')
    const all = [...xml.matchAll(/<version>([^<]+)<\/version>/g)].map(m => m[1]).filter(v => v.startsWith(prefix))
    const stable = all.filter(v => !v.includes('-'))
    const pick = (stable.length ? stable : all).pop()
    if (!pick) {
        throw new Error(`NeoForge has no builds for Minecraft ${mcVersion}.`)
    }
    return pick
}

function neoForgeInstallerUrl(version) {
    return `https://maven.neoforged.net/releases/net/neoforged/neoforge/${version}/neoforge-${version}-installer.jar`
}

/* ------------------------------------------------------------------ */
/* Modern Forge (1.13+) and NeoForge                                   */
/* ------------------------------------------------------------------ */

const FORGECLI_RELEASE_API = 'https://api.github.com/repos/3arthqu4ke/ForgeCLI/releases/latest'

/**
 * ForgeCLI (a small open source wrapper around the installer's own install
 * code) is the fallback if the installer's built-in headless mode fails. It
 * is downloaded once into the launcher's tools folder.
 */
async function ensureForgeCli(toolsDir, onProgress) {
    const jarPath = path.join(toolsDir, 'ForgeCLI.jar')
    if (fs.existsSync(jarPath)) return jarPath

    say(onProgress, 'Downloading ForgeCLI (one-time setup)...')
    const release = await net.getJson(FORGECLI_RELEASE_API)
    const asset = (release.assets || []).find(a => /\.jar$/i.test(a.name) && !/sources|javadoc/i.test(a.name))
    if (!asset) {
        throw new Error(`Could not find a ForgeCLI jar on GitHub. Download it manually from https://github.com/3arthqu4ke/ForgeCLI/releases and save it as ${jarPath}`)
    }
    await net.downloadToFile(asset.browser_download_url, jarPath)
    return jarPath
}

/**
 * Locates the loader's own jar (forge/neoforge) among the libraries the
 * installer wrote, returning a resolved {id, name, artifact} entry or null.
 */
function findInstalledLoaderJar(commonDir, loaderName, loaderVersion) {
    const isNeo = loaderName === 'NeoForge'
    const group = isNeo ? 'net.neoforged' : 'net.minecraftforge'
    const artifactName = isNeo ? 'neoforge' : 'forge'
    const base = path.join(commonDir, 'libraries', ...group.split('.'), artifactName)
    if (!fs.existsSync(base)) return null

    const wanted = loaderVersion.toLowerCase()
    const versionDir = fs.readdirSync(base).find(d => d.toLowerCase().includes(wanted))
    if (!versionDir) return null

    const jars = fs.readdirSync(path.join(base, versionDir)).filter(f => /\.jar$/i.test(f))
    const rank = f => /universal/i.test(f) ? 0 : /client|slim|extra|srg|shim/i.test(f) ? 2 : 1
    jars.sort((a, b) => rank(a) - rank(b))
    if (jars.length === 0) return null

    const file = jars[0]
    const prefix = `${artifactName}-${versionDir}`
    const classifier = file.startsWith(prefix + '-') ? file.slice(prefix.length + 1).replace(/\.jar$/i, '') : null
    const { size, md5 } = net.hashLocalFile(path.join(base, versionDir, file))
    return {
        id: `${group}:${artifactName}:${versionDir}${classifier ? ':' + classifier : ''}`,
        name: artifactName,
        artifact: { size, MD5: md5, url: '' }
    }
}

/**
 * Runs the real installer (via ForgeCLI) into the launcher's own common
 * directory, because the installer generates files (patched client jars
 * etc.) that exist nowhere to download, and they must land where the
 * launcher will look for them.
 *
 * NOTE: this path is untested against live installers from the build
 * environment; Forge and NeoForge share the installer codebase, which is
 * why one path serves both.
 */
async function resolveModernLoader({ installerUrl, loaderVersion, loaderName, forgeCliJarPath, toolsDir, javaExecutable, commonDir, onProgress }) {
    const versionsDir = path.join(commonDir, 'versions')
    const lcVersion = loaderVersion.toLowerCase()
    const findVersionId = () => {
        if (!fs.existsSync(versionsDir)) return undefined
        return fs.readdirSync(versionsDir).find(d => {
            const lc = d.toLowerCase()
            return lc.includes(lcVersion) && lc.includes('forge')
        })
    }

    // A marker file records a completed install, so rebuilding or re-adding
    // a pack on the same loader version skips the slow installer.
    let versionId = findVersionId()
    const alreadyInstalled = versionId != null && fs.existsSync(path.join(versionsDir, versionId, '.dawn-installed'))

    if (!alreadyInstalled) {
        say(onProgress, `Downloading ${loaderName} installer...`)
        const installerPath = path.join(os.tmpdir(), `dawn-${path.basename(new URL(installerUrl).pathname)}`)
        await net.downloadToFile(installerUrl, installerPath)

        // Installers expect a vanilla-style install folder.
        fs.mkdirSync(commonDir, { recursive: true })
        const profilesFile = path.join(commonDir, 'launcher_profiles.json')
        if (!fs.existsSync(profilesFile)) {
            fs.writeFileSync(profilesFile, JSON.stringify({ profiles: {}, version: 3 }))
        }

        say(onProgress, `Installing ${loaderName} (this can take a few minutes)...`)

        const runJava = args => new Promise((resolve, reject) => {
            const proc = spawn(javaExecutable, args)
            let output = ''
            proc.stdout.on('data', d => { output += d.toString() })
            proc.stderr.on('data', d => { output += d.toString() })
            const timer = setTimeout(() => {
                proc.kill()
                reject(new Error(`${loaderName} installer timed out after 15 minutes.`))
            }, 15 * 60 * 1000)
            proc.on('error', err => { clearTimeout(timer); reject(err) })
            proc.on('close', code => {
                clearTimeout(timer)
                if (code !== 0) {
                    reject(new Error(`exit ${code}. ${output.slice(-600)}`))
                } else {
                    resolve()
                }
            })
        })

        // First choice: the installer's own headless client install (Forge uses
        // --installClient, NeoForge --install-client). It is version-matched by
        // definition. ForgeCLI is only a fallback, since it can break when an
        // installer's internal API changes.
        const nativeFlag = loaderName === 'NeoForge' ? '--install-client' : '--installClient'
        try {
            await runJava(['-jar', installerPath, nativeFlag, commonDir])
        } catch (nativeErr) {
            say(onProgress, `Retrying ${loaderName} install another way...`)
            try {
                const cli = forgeCliJarPath || await ensureForgeCli(toolsDir, onProgress)
                await runJava(['-jar', cli, '--installer', installerPath, '--target', commonDir])
            } catch (cliErr) {
                throw new Error(`${loaderName} installer failed. ${String(nativeErr.message).slice(0, 400)}`)
            }
        }
        try { fs.unlinkSync(installerPath) } catch (err) { /* ignore */ }

        versionId = findVersionId()
        if (!versionId) {
            throw new Error(`${loaderName} installer finished but no version folder for ${loaderVersion} was found.`)
        }
        fs.writeFileSync(path.join(versionsDir, versionId, '.dawn-installed'), new Date().toISOString())
    }

    const versionJsonPath = path.join(versionsDir, versionId, `${versionId}.json`)
    const versionJsonText = fs.readFileSync(versionJsonPath, 'utf-8')
    const versionJson = JSON.parse(versionJsonText)

    const libs = await mapLibraries(versionJson.libraries, onProgress, loaderName, { commonDir })

    // The loader's own jar becomes the ForgeHosted module.
    let mainIdx = libs.findIndex(l => /^(net\.minecraftforge:forge|net\.neoforged:neoforge):[^:]+:universal$/.test(l.id))
    if (mainIdx === -1) {
        mainIdx = libs.findIndex(l => /^(net\.minecraftforge:forge|net\.neoforged:neoforge):/.test(l.id))
    }
    let mainLib
    if (mainIdx !== -1) {
        mainLib = libs.splice(mainIdx, 1)[0]
    } else {
        // Newer versions don't list the loader's own jar in the profile, but
        // the installer still puts it in the libraries folder. Find it there.
        mainLib = findInstalledLoaderJar(commonDir, loaderName, loaderVersion)
        if (!mainLib) {
            throw new Error(`The ${loaderName} install finished, but its main jar could not be found in the libraries folder.`)
        }
    }

    return {
        id: mainLib.id,
        name: loaderName,
        type: 'ForgeHosted',
        artifact: mainLib.artifact,
        subModules: [
            ...libs.map(l => ({ id: l.id, name: l.name, type: 'Library', artifact: l.artifact })),
            {
                id: versionJson.id,
                name: `${loaderName} Version Manifest`,
                type: 'VersionManifest',
                artifact: { size: Buffer.byteLength(versionJsonText), MD5: md5OfString(versionJsonText), url: '' }
            }
        ]
    }
}

module.exports = {
    findInstalledLoaderJar,
    getLatestFabricLoaderVersion,
    resolveFabric,
    getRecommendedForgeVersion,
    getForgeArtifactVersion,
    forgeInstallerUrl,
    resolveForgeLegacy,
    getLatestNeoForgeVersion,
    neoForgeInstallerUrl,
    ensureForgeCli,
    resolveModernLoader
}
