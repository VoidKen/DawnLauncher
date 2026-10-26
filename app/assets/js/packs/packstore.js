const https = require('https')
const crypto = require('crypto')

// Supabase project hosting the shared-pack table. The publishable key is
// designed to be embedded in client apps.
const SUPABASE_URL = 'https://kbggkguslsdzlgwnbkgt.supabase.co'
const SUPABASE_KEY = 'sb_publishable_hqTvDlOac9dogIfKEZ8Kiw_o2dZ5BsX'

function supabaseRequest(method, path, body) {
    return new Promise((resolve, reject) => {
        const url = new URL(SUPABASE_URL + path)
        const bodyStr = body ? JSON.stringify(body) : null

        const headers = {
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`,
            'Content-Type': 'application/json'
        }
        if (bodyStr) {
            headers['Content-Length'] = Buffer.byteLength(bodyStr)
            headers['Prefer'] = 'return=minimal'
        }

        const req = https.request({ hostname: url.hostname, path: url.pathname + url.search, method, headers }, res => {
            let data = ''
            res.on('data', chunk => data += chunk)
            res.on('end', () => {
                if (res.statusCode < 200 || res.statusCode >= 300) {
                    const down = res.statusCode >= 520 && res.statusCode <= 530
                    const err = new Error(down
                        ? 'The share-code database is switched off (error ' + res.statusCode + '). Free Supabase projects pause after a week of inactivity - open the Supabase dashboard, press Restore project, wait a minute or two, then try again.'
                        : `Share-code service returned ${res.statusCode}: ${data}`)
                    err.friendly = down
                    err.statusCode = res.statusCode
                    reject(err)
                    return
                }
                try {
                    resolve(data ? JSON.parse(data) : null)
                } catch (err) {
                    reject(new Error(`Failed to parse share-code response: ${err.message}`))
                }
            })
        })
        const unreachable = cause => {
            const err = new Error(`Could not reach the share-code database (${cause}). Modrinth works, so check that the Supabase project is not paused (free projects pause after a week of inactivity - open the Supabase dashboard and press Restore), then try again.`)
            err.friendly = true
            return err
        }
        req.on('error', e => reject(unreachable((e && (e.code || e.message)) || 'unknown error')))
        req.setTimeout(20000, () => req.destroy(unreachable('timed out')))
        if (bodyStr) req.write(bodyStr)
        req.end()
    })
}

// No 0/O/1/I/L so codes are easy to read out loud.
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

/** 8 random characters shown as XXXX-XXXX (~850 billion combinations). */
function generateCode() {
    let code = ''
    for (let i = 0; i < 8; i++) {
        code += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]
    }
    return code
}

function formatCode(code) {
    return `${code.slice(0, 4)}-${code.slice(4)}`
}

function normalizeCode(code) {
    return String(code).toUpperCase().replace(/[^A-Z0-9]/g, '')
}

/**
 * Saves a pack under a fresh code, retrying on the (very unlikely) chance
 * the code is already taken.
 *
 * @param {object} pack { name, mcVersion, loader, loaderVersion, mods }
 * @returns {Promise<string>} the formatted share code
 */
async function savePack(pack, attemptsLeft = 5) {
    const code = generateCode()
    try {
        await supabaseRequest('POST', '/rest/v1/packs', {
            code,
            name: pack.name,
            mc_version: pack.mcVersion,
            loader: pack.loader,
            // The mods column is JSON, so the loader version rides along with
            // the mod list to keep every friend on the identical loader.
            mods: { loaderVersion: pack.loaderVersion || null, mods: pack.mods }
        })
        return formatCode(code)
    } catch (err) {
        if (err.statusCode === 409 && attemptsLeft > 0) {
            return savePack(pack, attemptsLeft - 1)
        }
        throw err
    }
}

/**
 * @returns {Promise<object|null>} { name, mcVersion, loader, loaderVersion, mods } or null
 */
async function loadPack(code) {
    const normalized = normalizeCode(code)
    if (normalized.length < 6) return null
    const rows = await supabaseRequest('GET', `/rest/v1/packs?code=eq.${encodeURIComponent(normalized)}&select=*`)
    if (!rows || rows.length === 0) return null

    const row = rows[0]
    // Older rows stored the mod list directly as an array.
    const payload = Array.isArray(row.mods) ? { loaderVersion: null, mods: row.mods } : row.mods
    return {
        name: row.name,
        mcVersion: row.mc_version,
        loader: row.loader,
        loaderVersion: payload.loaderVersion || null,
        mods: payload.mods || []
    }
}

module.exports = { savePack, loadPack, formatCode, normalizeCode }
