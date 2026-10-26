const fs = require('fs')
const path = require('path')

/**
 * The launcher's local collection of packs.
 *
 * Every built pack is kept in dawn-packs.json, and distribution_dev.json
 * (the file helios-core reads in dev mode) is regenerated from the whole
 * collection, so each pack shows up in the launcher's normal server picker.
 */

const LIBRARY_FILE = 'dawn-packs.json'
const DISTRIBUTION_FILE = 'distribution_dev.json'
const PLACEHOLDER_ID = 'dawn-no-pack'

const PLACEHOLDER_SERVER = {
    id: PLACEHOLDER_ID,
    name: 'No pack yet',
    description: 'Open Mod Packs to build a pack or enter a share code.',
    icon: 'assets/images/dawn.png',
    version: '1.0.0',
    address: '',
    minecraftVersion: '1.20.1',
    mainServer: true,
    autoconnect: false,
    modules: []
}

function libraryPath(launcherRoot) {
    return path.join(launcherRoot, LIBRARY_FILE)
}

function list(launcherRoot) {
    try {
        const file = libraryPath(launcherRoot)
        if (fs.existsSync(file)) {
            const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'))
            return Array.isArray(parsed) ? parsed : []
        }
    } catch (err) {
        // A corrupt library file shouldn't brick the launcher; start fresh.
    }
    return []
}

function save(launcherRoot, packs) {
    fs.mkdirSync(launcherRoot, { recursive: true })
    fs.writeFileSync(libraryPath(launcherRoot), JSON.stringify(packs, null, 2))
}

/** Rewrites distribution_dev.json from the current collection. */
function writeDistribution(launcherRoot) {
    const packs = list(launcherRoot)
    const servers = packs.length > 0
        ? packs.map((p, i) => ({ ...p.server, mainServer: i === 0 }))
        : [PLACEHOLDER_SERVER]

    fs.mkdirSync(launcherRoot, { recursive: true })
    fs.writeFileSync(
        path.join(launcherRoot, DISTRIBUTION_FILE),
        JSON.stringify({ version: '1.0.0', rss: '', servers }, null, 2)
    )
}

/** Makes sure a loadable distribution exists, even on a brand new install. */
function ensureDistribution(launcherRoot) {
    if (!fs.existsSync(path.join(launcherRoot, DISTRIBUTION_FILE))) {
        writeDistribution(launcherRoot)
    }
}

function find(launcherRoot, id) {
    return list(launcherRoot).find(p => p.id === id) || null
}

function findByCode(launcherRoot, code) {
    return list(launcherRoot).find(p => p.code && p.code === code) || null
}

/** Adds or replaces a pack (matched by id) and refreshes the distribution. */
function upsert(launcherRoot, entry) {
    const packs = list(launcherRoot)
    const idx = packs.findIndex(p => p.id === entry.id)
    if (idx === -1) {
        packs.push(entry)
    } else {
        packs[idx] = entry
    }
    save(launcherRoot, packs)
    writeDistribution(launcherRoot)
}

function remove(launcherRoot, id) {
    save(launcherRoot, list(launcherRoot).filter(p => p.id !== id))
    writeDistribution(launcherRoot)
}

module.exports = {
    PLACEHOLDER_ID,
    list,
    find,
    findByCode,
    upsert,
    remove,
    writeDistribution,
    ensureDistribution
}
