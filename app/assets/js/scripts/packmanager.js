/**
 * Script for the "Mod Packs" overlay panel (packManagerContent in overlay.ejs).
 *
 * Players build their own packs from Modrinth inside the launcher, keep as
 * many as they like, and share any of them with a short code. Everything is
 * resolved locally (see assets/js/packs/) into distribution_dev.json, which
 * helios-core reads in dev mode, so the normal launch machinery is unchanged.
 *
 * NOTE: every <script> on this page shares one global scope, so top-level
 * names here are prefixed "pm" to avoid colliding with the other scripts.
 * require() paths are relative to app/, like the other scripts.
 */

const pmModrinth    = require('./assets/js/packs/modrinthapi')
const pmBuilder     = require('./assets/js/packs/packbuilder')
const pmLibrary     = require('./assets/js/packs/packlibrary')
const pmStore       = require('./assets/js/packs/packstore')
const pmImporter    = require('./assets/js/packs/packimport')
const pmCurseForge  = require('./assets/js/packs/curseforgeapi')
const pmNet         = require('./assets/js/packs/netutil')
pmCurseForge.setRoot(ConfigManager.getLauncherDirectory())
const pmRemote      = require('@electron/remote')
const { clipboard: pmClipboard } = require('electron')

const loggerPackManager = LoggerUtil.getLogger('PackManager')

/* ---- State ---- */

let pmMods = []              // mods in the pack being built: { projectId, versionId, title, fileName, isDependency }
let pmOffsets = { modrinth: 0, curseforge: 0 }
let pmTotals = { modrinth: 0, curseforge: 0 }
let pmSource = 'all'          // 'all' | 'modrinth' | 'curseforge'
let pmKind = 'mod'            // 'mod' | 'modpack'
let pmGameVersions = []
let pmSearchSeq = 0          // guards against out-of-order search responses
let pmSearchTimer = null
let pmVersionsLoaded = false
let pmBusy = false           // a build is running

/* ---- Elements ---- */

const pmEl = id => document.getElementById(id)
const pmTabs = {
    library: { tab: pmEl('pmTabLibrary'), panel: pmEl('pmLibraryPanel') },
    browse:  { tab: pmEl('pmTabBrowse'),  panel: pmEl('pmBrowsePanel') },
    code:    { tab: pmEl('pmTabCode'),    panel: pmEl('pmCodePanel') },
    import:  { tab: pmEl('pmTabImport'),  panel: pmEl('pmImportPanel') }
}

/* ---- Small helpers ---- */

function pmEscape(str) {
    const div = document.createElement('div')
    div.textContent = str == null ? '' : String(str)
    return div.innerHTML
}

function pmSetText(el, msg, isError = false) {
    el.innerHTML = pmEscape(msg)
    el.style.color = isError ? '#ff6b6b' : ''
}

function pmLoaderName(loader) {
    return { fabric: 'Fabric', forge: 'Forge', neoforge: 'NeoForge' }[loader] || loader
}

function pmFriendlyError(err) {
    if(err && err.friendly) return err.message
    const msg = err && err.message ? err.message : String(err)
    if(/ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|Timed out/i.test(msg)) {
        return 'Could not reach the internet. Check your connection and try again.'
    }
    return msg
}

/* ---- Overlay open/close + tabs ---- */

function togglePackManager(toggleState) {
    toggleOverlay(toggleState, true, 'packManagerContent')
    if(toggleState) {
        pmRenderLibrary()
        pmLoadGameVersions()
        pmSetTab(pmLibrary.list(ConfigManager.getLauncherDirectory()).length === 0 ? 'browse' : 'library')
    }
}

function pmSetTab(name) {
    for(const [key, { tab, panel }] of Object.entries(pmTabs)) {
        if(key === name) {
            tab.setAttribute('pmselected', '')
            panel.style.display = 'flex'
        } else {
            tab.removeAttribute('pmselected')
            panel.style.display = 'none'
        }
    }
    if(name === 'browse' && pmEl('pmResultsList').childElementCount === 0 && pmEl('pmMcVersion').value.trim()) {
        pmRunSearch(true)
    }
}
pmTabs.library.tab.onclick = () => { pmRenderLibrary(); pmSetTab('library') }
pmTabs.browse.tab.onclick = () => pmSetTab('browse')
pmTabs.code.tab.onclick = () => pmSetTab('code')
pmTabs.import.tab.onclick = () => pmSetTab('import')

pmEl('packManagerClose').onclick = () => toggleOverlay(false)

pmEl('pmAdvancedToggle').onclick = () => {
    const adv = pmEl('pmAdvancedMeta')
    adv.style.display = adv.style.display === 'none' ? 'flex' : 'none'
}

// Typing in these fields must not trigger the overlay's global Enter/Escape shortcuts.
for(const input of document.querySelectorAll('#packManagerContent input')) {
    input.addEventListener('keydown', e => e.stopPropagation())
}

/* Called by uibinder.js once the main UI is up: a brand-new install has no
   pack, so send the player straight to building one. */
function pmMaybeAutoOpen() {
    if(getCurrentView() !== VIEWS.landing || isOverlayVisible()) return
    if(pmLibrary.list(ConfigManager.getLauncherDirectory()).length === 0) {
        togglePackManager(true)
    }
}

/* ---- Applying library changes to the running launcher ---- */

/**
 * Re-reads distribution_dev.json and refreshes everything that depends on
 * the server list. If preferId is given (and exists) it becomes the active pack.
 */
async function pmReloadDistribution(preferId) {
    const data = await DistroAPI.refreshDistributionOrFallback()
    ensureJavaSettings(data)
    syncModConfigurations(data)

    let target = preferId != null ? data.getServerById(preferId) : null
    if(target == null) target = data.getServerById(ConfigManager.getSelectedServer())
    if(target == null) target = data.getMainServer()

    ConfigManager.setSelectedServer(target != null ? target.rawServer.id : null)
    ConfigManager.save()
    updateSelectedServer(target)
    refreshServerStatus()
    return data
}

/* ---- My Packs ---- */

function pmRenderLibrary() {
    const root = ConfigManager.getLauncherDirectory()
    const packs = pmLibrary.list(root)
    const selected = ConfigManager.getSelectedServer()
    const list = pmEl('pmLibraryList')

    if(packs.length === 0) {
        list.innerHTML = '<div class="pmEmptyMsg">No packs yet. Use "Build a Pack" or "Enter a Code" to get started.</div>'
        return
    }

    list.innerHTML = packs.map(p => {
        const isSel = p.id === selected
        const n = p.mods.length
        return `
        <div class="pmPackRow" data-id="${pmEscape(p.id)}" ${isSel ? 'pmactive' : ''}>
            <div class="pmPackTop">
                <span class="pmPackName">${pmEscape(p.name)}</span>
                ${isSel ? '<span class="pmBadge">SELECTED</span>' : ''}
            </div>
            <div class="pmPackTags">
                <span class="pmTag pmLoaderTag" data-loader="${pmEscape(p.loader)}">${pmEscape(pmLoaderName(p.loader))}</span>
                <span class="pmTag">${pmEscape(p.mcVersion)}</span>
                <span class="pmTag">${n} mod${n === 1 ? '' : 's'}</span>
                ${p.code ? '<span class="pmTag pmCodeTag">' + pmEscape(p.code) + '</span>' : '<span class="pmNoCode">No share code yet</span>'}
            </div>
            <div class="pmRowButtons">
                ${isSel ? '' : '<button class="pmPrimaryButton" data-act="use" type="button">Use</button>'}
                ${p.code
                    ? '<button class="pmAddButton" data-act="copy" type="button">Copy code</button>'
                    : '<button class="pmAddButton" data-act="share" type="button">Get code</button>'}
                <button class="pmRemoveButton" data-act="delete" type="button">Delete</button>
            </div>
        </div>`
    }).join('')
}

pmEl('pmLibraryList').addEventListener('click', async e => {
    const btn = e.target.closest('button[data-act]')
    if(!btn) return
    const row = btn.closest('.pmPackRow')
    const id = row.getAttribute('data-id')
    const root = ConfigManager.getLauncherDirectory()
    const pack = pmLibrary.find(root, id)
    const status = pmEl('pmLibraryStatus')
    if(!pack) return

    switch(btn.getAttribute('data-act')) {
        case 'use':
            await pmReloadDistribution(id)
            pmRenderLibrary()
            pmSetText(status, `"${pack.name}" is selected. Close this window and press Launch.`)
            break
        case 'copy':
            pmClipboard.writeText(pack.code)
            pmSetText(status, `Copied ${pack.code}`)
            break
        case 'share':
            btn.disabled = true
            pmSetText(status, 'Creating share code...')
            try {
                pack.code = await pmBuilder.sharePack(pmDefinitionOf(pack))
                pmLibrary.upsert(root, pack)
                pmRenderLibrary()
                pmSetText(status, `Share code: ${pack.code}`)
            } catch(err) {
                loggerPackManager.error('Failed to share pack', err)
                pmSetText(status, `Could not create a code: ${pmFriendlyError(err)}`, true)
                btn.disabled = false
            }
            break
        case 'delete':
            // Two-step: first click arms the button.
            if(btn.getAttribute('data-armed') !== 'true') {
                btn.setAttribute('data-armed', 'true')
                btn.textContent = 'Sure?'
                setTimeout(() => { if(btn.isConnected) { btn.removeAttribute('data-armed'); btn.textContent = 'Delete' } }, 3000)
                return
            }
            pmLibrary.remove(root, id)
            await pmReloadDistribution(null)
            pmRenderLibrary()
            pmSetText(status, `Deleted "${pack.name}".`)
            break
    }
})

/** The shareable definition of a stored pack (no built-server data). */
function pmDefinitionOf(pack) {
    return {
        name: pack.name,
        mcVersion: pack.mcVersion,
        loader: pack.loader,
        loaderVersion: pack.loaderVersion,
        mods: pack.mods
    }
}

/* ---- Build a Pack: version list, search, mod list ---- */

async function pmLoadGameVersions() {
    if(pmVersionsLoaded) return
    try {
        const versions = await pmModrinth.getReleaseGameVersions()
        pmGameVersions = versions
        if(!pmEl('pmMcVersion').value) pmEl('pmMcVersion').value = versions.includes('1.20.1') ? '1.20.1' : versions[0]
        pmVersionsLoaded = true
        if(pmTabs.browse.panel.style.display !== 'none') pmRunSearch(true)
    } catch(err) {
        loggerPackManager.warn('Could not load Minecraft version list', err)
    }
}

function pmSelection() {
    return { mcVersion: pmEl('pmMcVersion').value.trim(), loader: pmEl('pmLoader').value }
}

// Mods are tied to one Minecraft version + loader, so changing either resets the pack.
let pmLastSelectionKey = null
function pmSelectionChanged() {
    const { mcVersion, loader } = pmSelection()
    const key = `${mcVersion}|${loader}`
    if(pmLastSelectionKey != null && key !== pmLastSelectionKey && pmMods.length > 0) {
        pmMods = []
        pmRenderPackList()
        pmSetText(pmEl('pmBuildStatus'), 'Version or loader changed, so your mod list was cleared.')
    }
    pmLastSelectionKey = key
    pmRunSearch(true)
}
pmEl('pmMcVersion').addEventListener('change', pmSelectionChanged)

// Scrollable version dropdown (replaces the browser's datalist).
function pmRenderVersionList(filter) {
    const list = pmEl('pmVersionList')
    const f = (filter || '').trim()
    const current = pmEl('pmMcVersion').value.trim()
    const items = pmGameVersions.filter(v => !f || v.startsWith(f))
    list.innerHTML = items.length > 0
        ? items.map(v => `<div class="pmVersionItem" data-v="${pmEscape(v)}" ${v === current ? 'pmselected' : ''}>${pmEscape(v)}</div>`).join('')
        : '<div class="pmEmptyMsg">No match. You can still type any version.</div>'
}
function pmShowVersionList(filter) {
    pmRenderVersionList(filter)
    pmEl('pmVersionList').style.display = 'block'
    const sel = pmEl('pmVersionList').querySelector('[pmselected]')
    if(sel) sel.scrollIntoView({ block: 'center' })
}
pmEl('pmMcVersion').addEventListener('focus', () => pmShowVersionList(''))
pmEl('pmMcVersion').addEventListener('click', () => pmShowVersionList(''))
pmEl('pmMcVersion').addEventListener('input', e => pmShowVersionList(e.target.value))
pmEl('pmMcVersion').addEventListener('blur', () => { pmEl('pmVersionList').style.display = 'none' })
pmEl('pmVersionList').addEventListener('mousedown', e => {
    e.preventDefault() // keep focus so the list does not close before the click registers
    const item = e.target.closest('.pmVersionItem')
    if(!item) return
    pmEl('pmMcVersion').value = item.getAttribute('data-v')
    pmEl('pmVersionList').style.display = 'none'
    pmEl('pmMcVersion').dispatchEvent(new Event('change'))
})

// Source / type filters.
function pmBindSegment(id, attr, onPick) {
    pmEl(id).addEventListener('click', e => {
        const btn = e.target.closest('button')
        if(!btn) return
        for(const b of pmEl(id).querySelectorAll('button')) b.removeAttribute('pmselected')
        btn.setAttribute('pmselected', '')
        onPick(btn.getAttribute(attr))
        pmRunSearch(true)
    })
}
pmBindSegment('pmSourceFilter', 'data-source', v => { pmSource = v })
pmBindSegment('pmKindFilter', 'data-kind', v => { pmKind = v })

function pmNeoForgeTooOld(mcVersion, loader) {
    if(loader !== 'neoforge') return false
    const [maj, min, patch] = mcVersion.split('.').map(Number)
    return maj === 1 && (min < 20 || (min === 20 && (patch || 0) < 2))
}
pmEl('pmLoader').addEventListener('change', pmSelectionChanged)
pmEl('pmSearchQuery').addEventListener('input', () => {
    clearTimeout(pmSearchTimer)
    pmSearchTimer = setTimeout(() => pmRunSearch(true), 400)
})

const pmApis = () => ({ modrinth: pmModrinth, curseforge: pmCurseForge })
const pmSrcOf = id => String(id).startsWith('cf:') ? 'curseforge' : 'modrinth'

async function pmRunSearch(reset) {
    const { mcVersion, loader } = pmSelection()
    const list = pmEl('pmResultsList')
    if(!/^\d+\.\d+(\.\d+)?$/.test(mcVersion)) {
        list.innerHTML = '<div class="pmEmptyMsg">Enter a Minecraft version (for example 1.20.1).</div>'
        return
    }
    if(pmLastSelectionKey == null) pmLastSelectionKey = `${mcVersion}|${loader}`

    if(reset) {
        pmOffsets = { modrinth: 0, curseforge: 0 }
        pmTotals = { modrinth: 0, curseforge: 0 }
        list.innerHTML = '<div class="pmEmptyMsg">Searching...</div>'
    }
    const seq = ++pmSearchSeq
    const sources = pmSource === 'all' ? ['modrinth', 'curseforge'] : [pmSource]
    const perPage = sources.length > 1 ? 10 : 20
    const query = pmEl('pmSearchQuery').value.trim()
    const kind = pmKind
    const apis = pmApis()

    const settled = await Promise.allSettled(sources.map(src =>
        (reset || pmOffsets[src] < pmTotals[src])
            ? apis[src].searchMods(query, mcVersion, loader, perPage, pmOffsets[src], kind)
            : Promise.resolve({ hits: [], total: pmTotals[src] })))
    if(seq !== pmSearchSeq) return // a newer search superseded this one

    const lists = []
    const errors = []
    settled.forEach((r, i) => {
        const src = sources[i]
        if(r.status === 'fulfilled') {
            pmTotals[src] = r.value.total
            pmOffsets[src] += r.value.hits.length
            lists.push(r.value.hits)
        } else {
            loggerPackManager.error(`${src} search failed`, r.reason)
            errors.push(`${src === 'curseforge' ? 'CurseForge' : 'Modrinth'}: ${pmFriendlyError(r.reason)}`)
        }
    })

    const loadMore = list.querySelector('.pmLoadMore')
    if(loadMore) loadMore.remove()
    list.querySelector('.pmSearchNote')?.remove()
    if(reset) list.innerHTML = ''

    // Interleave so both sources show up near the top.
    const hits = []
    for(let i = 0; lists.some(l => i < l.length); i++) {
        for(const l of lists) if(i < l.length) hits.push(l[i])
    }

    if(hits.length === 0 && reset) {
        list.innerHTML = errors.length > 0
            ? `<div class="pmEmptyMsg">Search failed. ${pmEscape(errors.join(' | '))}</div>`
            : `<div class="pmEmptyMsg">No ${kind === 'modpack' ? 'modpacks' : 'mods'} found.</div>`
        return
    }

    const verb = kind === 'modpack' ? 'Install' : 'Add'
    list.insertAdjacentHTML('beforeend', hits.map(hit => {
        const src = pmSrcOf(hit.id)
        const added = kind === 'mod' && pmMods.some(m => m.projectId === hit.id)
        return `
        <div class="pmResultRow" data-project-id="${pmEscape(hit.id)}" data-title="${pmEscape(hit.title)}" data-source="${src}">
            <img class="pmResultIcon" src="${pmEscape(hit.iconUrl || 'assets/images/dawn.png')}"/>
            <div class="pmResultDetails">
                <span class="pmResultTitle">${pmEscape(hit.title)} <span class="pmSrc" data-src="${src}">${src === 'curseforge' ? 'CurseForge' : 'Modrinth'}</span></span>
                <span class="pmResultDesc">${pmEscape(hit.description || '')}</span>
            </div>
            <button class="pmAddButton" type="button" ${added ? 'disabled' : ''}>${added ? 'Added' : verb}</button>
        </div>`
    }).join(''))

    if(errors.length > 0) {
        list.insertAdjacentHTML('beforeend', `<div class="pmEmptyMsg pmSearchNote">${pmEscape(errors.join(' | '))}</div>`)
    }
    if(sources.some(src => pmOffsets[src] < pmTotals[src])) {
        list.insertAdjacentHTML('beforeend', '<button class="pmLoadMore pmAddButton" type="button">Load more</button>')
    }
}

pmEl('pmResultsList').addEventListener('click', async e => {
    if(e.target.closest('.pmLoadMore')) {
        e.target.closest('.pmLoadMore').disabled = true
        pmRunSearch(false)
        return
    }
    const btn = e.target.closest('.pmAddButton')
    if(!btn || btn.disabled) return
    const row = btn.closest('.pmResultRow')
    const id = row.getAttribute('data-project-id')
    const title = row.getAttribute('data-title')
    btn.disabled = true
    if(pmKind === 'modpack') {
        btn.textContent = '...'
        const ok = await pmInstallModpack(row.getAttribute('data-source'), id, title)
        btn.textContent = ok ? 'Installed' : 'Install'
        btn.disabled = ok
        return
    }
    btn.textContent = '...'
    const ok = await pmAddMod(id, title)
    btn.textContent = ok ? 'Added' : 'Add'
    btn.disabled = ok
})

/** Downloads a modpack from Modrinth/CurseForge and imports it as a new pack. */
async function pmInstallModpack(source, id, title) {
    if(pmBusy) return false
    const { mcVersion, loader } = pmSelection()
    const status = pmEl('pmBuildStatus')
    pmBusy = true
    try {
        pmSetText(status, `Finding ${title}...`)
        const file = await pmApis()[source].getModpackFile(id, mcVersion, loader)
        const tmp = require('path').join(ConfigManager.getLauncherDirectory(), 'tmp', file.fileName)
        pmSetText(status, `Downloading ${title}...`)
        await pmNet.downloadToFile(file.url, tmp)
        const { entry, note } = await pmDoImport(tmp, {}, msg => pmSetText(status, `${title}: ${msg}`))
        try { require('fs').unlinkSync(tmp) } catch(e) { /* leftover temp file is harmless */ }
        pmSetText(status, `"${entry.name}" installed and selected${note ? ` (${note})` : ''}. Open My Packs, close this window and press Launch.`)
        return true
    } catch(err) {
        loggerPackManager.error('Failed to install modpack', err)
        pmSetText(status, `Could not install ${title}: ${pmFriendlyError(err)}`, true)
        return false
    } finally {
        pmBusy = false
    }
}

/** Adds a mod plus everything it requires. Resolves true on success. */
async function pmAddMod(projectId, title) {
    const { mcVersion, loader } = pmSelection()
    const status = pmEl('pmBuildStatus')
    try {
        const have = new Set(pmMods.map(m => m.projectId))
        const isCf = pmSrcOf(projectId) === 'curseforge'
        const resolved = await pmApis()[isCf ? 'curseforge' : 'modrinth'].resolveWithDependencies(projectId, mcVersion, loader, have)
        if(resolved.length === 0) return true // already in the pack

        const depList = resolved.filter(r => r.isDependency)
        const titles = isCf
            ? await pmCurseForge.getTitles(depList.map(r => r.modId)).catch(() => ({}))
            : await pmModrinth.getProjectTitles(depList.map(r => r.projectId)).catch(() => ({}))
        for(const r of resolved) {
            const depTitle = isCf ? titles[r.modId] : titles[r.projectId]
            pmMods.push({
                projectId: r.projectId,
                versionId: r.versionId,
                source: isCf ? 'curseforge' : 'modrinth',
                url: r.url,
                fileName: r.fileName,
                isDependency: r.isDependency,
                title: r.isDependency ? (depTitle || r.fileName) : title
            })
        }
        pmRenderPackList()
        const deps = resolved.filter(r => r.isDependency).length
        pmSetText(status, deps > 0 ? `Added ${title} and ${deps} required mod${deps === 1 ? '' : 's'}.` : `Added ${title}.`)
        return true
    } catch(err) {
        loggerPackManager.error('Failed to add mod', err)
        pmSetText(status, `Could not add ${title}: ${pmFriendlyError(err)}`, true)
        return false
    }
}

function pmRenderPackList() {
    const list = pmEl('pmPackList')
    pmEl('pmPackCount').textContent = pmMods.length > 0 ? `(${pmMods.length})` : ''
    if(pmMods.length === 0) {
        list.innerHTML = '<div class="pmEmptyMsg">No mods yet. Search above and press Add.</div>'
        return
    }
    list.innerHTML = pmMods.map(mod => `
        <div class="pmResultRow" data-project-id="${pmEscape(mod.projectId)}">
            <div class="pmResultDetails">
                <span class="pmResultTitle">${pmEscape(mod.title)}${mod.isDependency ? ' <span class="pmBadge">REQUIRED</span>' : ''}</span>
                <span class="pmResultDesc">${pmEscape(mod.fileName)}</span>
            </div>
            <button class="pmRemoveButton" type="button">Remove</button>
        </div>
    `).join('')
}

pmEl('pmPackList').addEventListener('click', e => {
    const btn = e.target.closest('.pmRemoveButton')
    if(!btn) return
    const id = btn.closest('.pmResultRow').getAttribute('data-project-id')
    pmMods = pmMods.filter(m => m.projectId !== id)
    pmRenderPackList()
    // Re-enable the matching "Added" button in the results, if visible.
    const resultRow = pmEl('pmResultsList').querySelector(`.pmResultRow[data-project-id="${CSS.escape(id)}"] .pmAddButton`)
    if(resultRow) { resultRow.disabled = false; resultRow.textContent = 'Add' }
})

/* ---- Building ---- */

/** Finds a Java for running the Forge/NeoForge installer. */
async function pmGetJavaExecutable() {
    const override = pmEl('pmJavaExecutable').value.trim()
    if(override) return override

    const jvm = await discoverBestJvmInstallation(ConfigManager.getDataDirectory(), '>=17.x')
    if(jvm != null) return javaExecFromRoot(jvm.path)

    throw new Error('Java 17 or newer is needed to install Forge/NeoForge and none was found. Launch a Fabric pack once so the launcher can install Java, or paste a Java path under Advanced options.')
}

function pmBuildOptions(onProgress, serverId) {
    return {
        launcherRoot: ConfigManager.getLauncherDirectory(),
        commonDir: ConfigManager.getCommonDirectory(),
        getJavaExecutable: pmGetJavaExecutable,
        serverId,
        onProgress
    }
}

/** Builds a pack definition, stores it in the library and selects it. */
async function pmBuildAndStore(definition, code, onProgress, serverId) {
    const root = ConfigManager.getLauncherDirectory()
    const { server, loaderVersion } = await pmBuilder.buildPack(definition, pmBuildOptions(onProgress, serverId))
    const entry = {
        id: server.id,
        name: definition.name,
        mcVersion: definition.mcVersion,
        loader: definition.loader,
        loaderVersion,
        mods: definition.mods,
        code: code || null,
        server,
        createdAt: Date.now()
    }
    pmLibrary.upsert(root, entry)
    await pmReloadDistribution(entry.id)
    return entry
}

pmEl('pmGenerateCodeButton').onclick = async () => {
    if(pmBusy) return
    const status = pmEl('pmBuildStatus')
    const name = pmEl('pmPackName').value.trim()
    const { mcVersion, loader } = pmSelection()

    if(!name) return pmSetText(status, 'Give your pack a name first.', true)
    if(!/^\d+\.\d+(\.\d+)?$/.test(mcVersion)) return pmSetText(status, 'Enter a valid Minecraft version, like 1.20.1.', true)
    if(pmNeoForgeTooOld(mcVersion, loader)) return pmSetText(status, 'NeoForge only exists for Minecraft 1.20.2 and newer. Pick Forge or Fabric for this version, or choose a newer Minecraft version.', true)
    if(pmMods.length === 0) return pmSetText(status, 'Add at least one mod to your pack.', true)

    pmBusy = true
    const button = pmEl('pmGenerateCodeButton')
    button.disabled = true
    pmEl('pmCodeResult').style.display = 'none'

    const definition = {
        name,
        mcVersion,
        loader,
        loaderVersion: pmEl('pmLoaderVersion').value.trim() || null,
        mods: pmMods.map(m => m.source === 'curseforge'
            ? { url: m.url, fileName: m.fileName, title: m.title, isDependency: !!m.isDependency }
            : { projectId: m.projectId, versionId: m.versionId, title: m.title, fileName: m.fileName, isDependency: !!m.isDependency })
    }

    try {
        const entry = await pmBuildAndStore(definition, null, msg => pmSetText(status, msg))

        pmSetText(status, 'Creating share code...')
        try {
            entry.code = await pmBuilder.sharePack(pmDefinitionOf(entry))
            pmLibrary.upsert(ConfigManager.getLauncherDirectory(), entry)
            pmEl('pmGeneratedCode').textContent = entry.code
            pmEl('pmCodeResult').style.display = 'flex'
            pmSetText(status, 'Your pack is ready and selected. Close this window and press Launch!')
        } catch(shareErr) {
            // The pack itself is fine; only the shareable code failed.
            loggerPackManager.error('Failed to create share code', shareErr)
            pmSetText(status, `Your pack is ready, but the share code could not be created (${pmFriendlyError(shareErr)}). You can get one later from My Packs.`, true)
        }
    } catch(err) {
        loggerPackManager.error('Failed to build pack', err)
        pmSetText(status, `Something went wrong: ${pmFriendlyError(err)}`, true)
    } finally {
        pmBusy = false
        button.disabled = false
    }
}

pmEl('pmCopyCodeButton').onclick = () => {
    pmClipboard.writeText(pmEl('pmGeneratedCode').textContent)
    pmEl('pmCopyCodeButton').textContent = 'Copied!'
    setTimeout(() => { pmEl('pmCopyCodeButton').textContent = 'Copy code' }, 1500)
}

/* ---- Enter a Code ---- */

pmEl('pmRedeemCode').addEventListener('input', e => {
    // Show codes as XXXX-XXXX while typing.
    const raw = pmStore.normalizeCode(e.target.value).slice(0, 8)
    e.target.value = raw.length > 4 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : raw
})
pmEl('pmRedeemCode').addEventListener('keydown', e => {
    if(e.key === 'Enter') pmEl('pmRedeemButton').click()
})

pmEl('pmRedeemButton').onclick = async () => {
    if(pmBusy) return
    const status = pmEl('pmRedeemStatus')
    const code = pmStore.normalizeCode(pmEl('pmRedeemCode').value)
    if(code.length !== 8) return pmSetText(status, 'Codes look like XXXX-XXXX.', true)

    const formatted = pmStore.formatCode(code)
    const root = ConfigManager.getLauncherDirectory()
    const button = pmEl('pmRedeemButton')
    pmBusy = true
    button.disabled = true

    try {
        const existing = pmLibrary.findByCode(root, formatted)
        if(existing) {
            await pmReloadDistribution(existing.id)
            pmSetText(status, `You already have "${existing.name}". It is now selected.`)
            return
        }

        pmSetText(status, 'Looking up pack...')
        const pack = await pmBuilder.fetchSharedPack(code)
        if(pack == null) {
            pmSetText(status, 'No pack found for that code. Check it was typed correctly.', true)
            return
        }

        const entry = await pmBuildAndStore(pack, formatted, msg => pmSetText(status, `${pack.name}: ${msg}`))
        pmSetText(status, `"${entry.name}" is ready and selected. Close this window and press Launch!`)
        pmEl('pmRedeemCode').value = ''
    } catch(err) {
        loggerPackManager.error('Failed to redeem pack code', err)
        pmSetText(status, `Something went wrong: ${pmFriendlyError(err)}`, true)
    } finally {
        pmBusy = false
        button.disabled = false
    }
}

pmRenderPackList()

/* ---- Import ---- */

const { webUtils: pmWebUtils } = require('electron')

let pmImportPath = null
let pmImportPercent = 0

function pmSetProgress(percent, done = false) {
    pmImportPercent = Math.max(pmImportPercent, Math.min(100, percent))
    const fill = pmEl('pmImportBarFill')
    fill.style.width = `${pmImportPercent}%`
    if(done) fill.setAttribute('pmdone', '')
    else fill.removeAttribute('pmdone')
    pmEl('pmImportPercent').textContent = `${Math.floor(pmImportPercent)}%`
}

function pmResetProgress(show) {
    pmImportPercent = 0
    pmEl('pmImportProgress').style.display = show ? 'flex' : 'none'
    pmSetProgress(0)
}

/** Maps the builder's status messages onto one overall 0-100 bar. */
function pmImportProgressFrom(msg) {
    const m = /\((\d+)\/(\d+)\)/.exec(msg)
    const frac = m ? (Number(m[1]) / Math.max(1, Number(m[2]))) : 0
    if(/CurseForge/i.test(msg) && m) pmSetProgress(2 + frac * 8)
    else if(/Preparing mods/i.test(msg) && m) pmSetProgress(35 + frac * 50)
    else if(/extra files/i.test(msg) && m) pmSetProgress(85 + frac * 12)
    else if(/Copying mods/i.test(msg)) pmSetProgress(10)
    else if(/Looking up mods/i.test(msg)) pmSetProgress(33)
    else pmSetProgress(12) // loader download/install steps
}

function pmImportSelect(filePath) {
    const status = pmEl('pmImportStatus')
    pmImportPath = null
    pmEl('pmImportButton').disabled = true
    pmEl('pmImportJarOptions').style.display = 'none'
    pmResetProgress(false)
    try {
        const info = pmImporter.inspectArchive(filePath)
        pmImportPath = filePath
        const kinds = { mrpack: 'Modrinth', curseforge: 'CurseForge', jars: 'Mod files' }
        const badge = pmEl('pmImportBadge')
        badge.textContent = kinds[info.kind]
        badge.setAttribute('pmkind', info.kind)
        pmEl('pmImportName').textContent = info.name
        pmEl('pmImportMeta').textContent = info.kind === 'jars'
            ? `${info.modCount} mod file${info.modCount === 1 ? '' : 's'} - pick the version and loader below`
            : `Minecraft ${info.mcVersion}  |  ${pmLoaderName(info.loader)}  |  ${info.modCount} mod${info.modCount === 1 ? '' : 's'}`
        pmEl('pmDropZone').style.display = 'none'
        pmEl('pmImportCard').style.display = 'flex'
        pmEl('pmImportJarOptions').style.display = info.kind === 'jars' ? 'flex' : 'none'
        pmEl('pmImportButton').disabled = false
        pmSetText(status, '')
    } catch(err) {
        pmEl('pmImportCard').style.display = 'none'
        pmEl('pmDropZone').style.display = 'flex'
        pmSetText(status, err.message, true)
    }
}

async function pmImportBrowse() {
    if(pmBusy) return
    const res = await pmRemote.dialog.showOpenDialog(pmRemote.getCurrentWindow(), {
        title: 'Choose a modpack',
        properties: ['openFile'],
        filters: [{ name: 'Modpacks', extensions: ['mrpack', 'zip'] }]
    })
    if(!res.canceled && res.filePaths.length > 0) pmImportSelect(res.filePaths[0])
}

const pmDropZone = pmEl('pmDropZone')
pmDropZone.onclick = pmImportBrowse
pmDropZone.onkeydown = e => { if(e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pmImportBrowse() } }
pmEl('pmImportChange').onclick = () => { if(!pmBusy) pmImportBrowse() }

for(const ev of ['dragenter', 'dragover']) {
    pmEl('pmImportPanel').addEventListener(ev, e => { e.preventDefault(); pmDropZone.setAttribute('pmdrag', '') })
}
for(const ev of ['dragleave', 'drop']) {
    pmEl('pmImportPanel').addEventListener(ev, e => { e.preventDefault(); pmDropZone.removeAttribute('pmdrag') })
}
pmEl('pmImportPanel').addEventListener('drop', e => {
    if(pmBusy) return
    const file = e.dataTransfer.files[0]
    if(!file) return
    const filePath = pmWebUtils.getPathForFile(file)
    if(!/\.(mrpack|zip)$/i.test(filePath)) return pmSetText(pmEl('pmImportStatus'), 'Drop a .mrpack or .zip file.', true)
    pmImportSelect(filePath)
})

/** Reads an archive, builds the pack and copies its extra files. */
async function pmDoImport(filePath, extra, onProgress) {
    const prepared = await pmImporter.prepareImport(filePath, Object.assign({
        launcherRoot: ConfigManager.getLauncherDirectory(),
        commonDir: ConfigManager.getCommonDirectory(),
        onProgress
    }, extra))
    const entry = await pmBuildAndStore(prepared.definition, null, onProgress, prepared.serverId)
    const instanceDir = require('path').join(ConfigManager.getInstanceDirectory(), prepared.serverId)
    const note = await prepared.finish(instanceDir)
    return { entry, note }
}

pmEl('pmImportButton').onclick = async () => {
    if(pmBusy || !pmImportPath) return
    const status = pmEl('pmImportStatus')
    const button = pmEl('pmImportButton')
    pmBusy = true
    button.disabled = true
    pmEl('pmImportChange').style.display = 'none'
    pmResetProgress(true)
    pmSetProgress(2)
    try {
        const onProgress = msg => { pmSetText(status, msg); pmImportProgressFrom(msg) }
        const { entry, note } = await pmDoImport(pmImportPath, {
            mcVersion: pmEl('pmImportMcVersion').value.trim(),
            loader: pmEl('pmImportLoader').value
        }, onProgress)
        pmSetProgress(100, true)
        pmImportPath = null
        pmEl('pmImportCard').style.display = 'none'
        pmEl('pmDropZone').style.display = 'flex'
        pmEl('pmImportJarOptions').style.display = 'none'
        pmSetText(status, `"${entry.name}" imported and selected${note ? ` (${note})` : ''}. Close this window and press Launch.`)
    } catch(err) {
        loggerPackManager.error('Failed to import pack', err)
        pmResetProgress(false)
        pmSetText(status, `Import failed: ${pmFriendlyError(err)}`, true)
        button.disabled = false
    } finally {
        pmBusy = false
        pmEl('pmImportChange').style.display = ''
    }
}
