const net = require('./netutil')

const MODRINTH = 'https://api.modrinth.com'

// Public, read-only endpoints: no API key or login required.
function modrinthGet(pathAndQuery) {
    return net.getJson(MODRINTH + pathAndQuery)
}

/**
 * Search Modrinth for mods compatible with a Minecraft version + loader.
 * @returns {Promise<{hits: Array, total: number}>}
 */
async function searchMods(query, mcVersion, loader, limit = 20, offset = 0, kind = 'mod') {
    const facets = JSON.stringify([
        [`project_type:${kind}`],
        [`versions:${mcVersion}`],
        [`categories:${loader}`]
    ])
    const params = new URLSearchParams({
        query: query || '',
        facets,
        limit: String(limit),
        offset: String(offset),
        index: query ? 'relevance' : 'downloads'
    })
    const result = await modrinthGet(`/v2/search?${params.toString()}`)
    return {
        total: result.total_hits,
        hits: result.hits.map(hit => ({
            id: hit.project_id,
            slug: hit.slug,
            title: hit.title,
            description: hit.description,
            iconUrl: hit.icon_url,
            downloads: hit.downloads,
            author: hit.author
        }))
    }
}

/**
 * Compatible versions of a project, best first: releases before
 * betas/alphas, newest first within each group.
 */
async function getModVersions(projectId, mcVersion, loader) {
    const params = new URLSearchParams({
        game_versions: JSON.stringify([mcVersion]),
        loaders: JSON.stringify([loader])
    })
    const versions = await modrinthGet(`/v2/project/${projectId}/version?${params.toString()}`)
    const rank = { release: 0, beta: 1, alpha: 2 }
    const sorted = versions
        .map((v, idx) => ({ v, idx }))
        .sort((a, b) => (rank[a.v.version_type] ?? 3) - (rank[b.v.version_type] ?? 3) || a.idx - b.idx)
        .map(x => x.v)

    return sorted.map(v => {
        const file = v.files.find(f => f.primary) || v.files[0]
        return {
            versionId: v.id,
            versionNumber: v.version_number,
            versionType: v.version_type,
            projectId: v.project_id,
            fileUrl: file.url,
            fileName: file.filename,
            fileSize: file.size,
            sha1: file.hashes.sha1,
            sha512: file.hashes.sha512,
            dependencies: (v.dependencies || [])
                .filter(d => d.dependency_type === 'required')
                .map(d => ({ projectId: d.project_id, versionId: d.version_id }))
        }
    })
}

/** Fetches one specific version by id (used when a saved pack pins versions). */
async function getVersionById(versionId) {
    const v = await modrinthGet(`/v2/version/${versionId}`)
    const file = v.files.find(f => f.primary) || v.files[0]
    return {
        versionId: v.id,
        versionNumber: v.version_number,
        versionType: v.version_type,
        projectId: v.project_id,
        fileUrl: file.url,
        fileName: file.filename,
        fileSize: file.size,
        sha1: file.hashes.sha1,
        sha512: file.hashes.sha512,
        dependencies: (v.dependencies || [])
            .filter(d => d.dependency_type === 'required')
            .map(d => ({ projectId: d.project_id, versionId: d.version_id }))
    }
}

/** Looks up display titles for many projects in one request. */
async function getProjectTitles(projectIds) {
    const titles = {}
    if (projectIds.length === 0) return titles
    const params = new URLSearchParams({ ids: JSON.stringify(projectIds) })
    const projects = await modrinthGet(`/v2/projects?${params.toString()}`)
    for (const p of projects) {
        titles[p.id] = p.title
    }
    return titles
}

async function getModDetails(projectId) {
    const project = await modrinthGet(`/v2/project/${projectId}`)
    return {
        id: project.id,
        slug: project.slug,
        title: project.title,
        description: project.description,
        body: project.body,
        iconUrl: project.icon_url,
        downloads: project.downloads,
        categories: project.categories,
        gameVersions: project.game_versions,
        loaders: project.loaders
    }
}

/**
 * Picks the best version of a project and everything it requires,
 * recursively. Projects already in `have` (a Set of project ids) are
 * skipped, so shared dependencies are only added once.
 *
 * @returns {Promise<Array<{projectId, versionId, fileName, isDependency}>>}
 *   the requested project first, followed by newly needed dependencies.
 */
async function resolveWithDependencies(projectId, mcVersion, loader, have = new Set()) {
    const out = []

    async function visit(pid, versionId, isDependency) {
        if (have.has(pid)) return
        have.add(pid)

        let version
        if (versionId) {
            version = await getVersionById(versionId)
        } else {
            const versions = await getModVersions(pid, mcVersion, loader)
            version = versions[0]
        }
        if (!version) {
            if (isDependency) {
                // A dependency with no matching build is skipped rather than
                // failing the whole pack; the mod may bundle it.
                return
            }
            throw new Error(`No version compatible with ${loader} ${mcVersion}.`)
        }

        out.push({ projectId: pid, versionId: version.versionId, fileName: version.fileName, isDependency })

        let deps = version.dependencies
        if (!deps) {
            const full = (await getModVersions(pid, mcVersion, loader)).find(v => v.versionId === version.versionId)
            deps = full ? full.dependencies : []
        }
        for (const dep of deps) {
            if (dep.projectId) {
                await visit(dep.projectId, null, true)
            }
        }
    }

    await visit(projectId, null, false)
    return out
}

/** Release versions of Minecraft, newest first, for the version picker. */
async function getReleaseGameVersions() {
    const tags = await modrinthGet('/v2/tag/game_version')
    return tags.filter(t => t.version_type === 'release').map(t => t.version)
}

/** The newest .mrpack file of a modpack for a Minecraft version + loader. */
async function getModpackFile(projectId, mcVersion, loader) {
    const params = new URLSearchParams({
        game_versions: JSON.stringify([mcVersion]),
        loaders: JSON.stringify([loader])
    })
    const versions = await modrinthGet(`/v2/project/${projectId}/version?${params.toString()}`)
    const rank = { release: 0, beta: 1, alpha: 2 }
    versions.sort((a, b) => (rank[a.version_type] ?? 3) - (rank[b.version_type] ?? 3))
    for (const v of versions) {
        const file = v.files.find(f => /\.mrpack$/i.test(f.filename))
        if (file) return { url: file.url, fileName: file.filename }
    }
    throw new Error(`No downloadable version of this modpack for ${loader} ${mcVersion}.`)
}

module.exports = {
    getModpackFile,
    searchMods,
    getModVersions,
    getVersionById,
    getProjectTitles,
    getModDetails,
    resolveWithDependencies,
    getReleaseGameVersions
}
