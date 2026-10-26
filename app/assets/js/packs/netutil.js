const https = require('https')
const http = require('http')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const USER_AGENT = 'DawnLauncher/1.0 (custom Minecraft launcher)'

/**
 * Opens a GET request, following up to 8 redirects. Resolves with the final
 * (successful) response stream, or rejects on a non-2xx status.
 */
function openStream(url, method = 'GET', redirectsLeft = 8) {
    return new Promise((resolve, reject) => {
        const target = new URL(url)
        const lib = target.protocol === 'http:' ? http : https
        const req = lib.request(target, { method, headers: { 'User-Agent': USER_AGENT } }, res => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                res.resume()
                if (redirectsLeft <= 0) {
                    reject(new Error(`Too many redirects fetching ${url}`))
                    return
                }
                const next = new URL(res.headers.location, target).toString()
                resolve(openStream(next, method, redirectsLeft - 1))
                return
            }
            if (res.statusCode < 200 || res.statusCode >= 300) {
                res.resume()
                reject(new Error(`${url} returned HTTP ${res.statusCode}`))
                return
            }
            resolve(res)
        })
        req.on('error', reject)
        req.setTimeout(30000, () => req.destroy(new Error(`Timed out fetching ${url}`)))
        req.end()
    })
}

async function getText(url) {
    const res = await openStream(url)
    return new Promise((resolve, reject) => {
        const chunks = []
        res.on('data', c => chunks.push(c))
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
        res.on('error', reject)
    })
}

async function getJson(url) {
    const text = await getText(url)
    try {
        return JSON.parse(text)
    } catch (err) {
        throw new Error(`Failed to parse JSON from ${url}: ${err.message}`)
    }
}

/** True if a URL responds successfully to a HEAD request. */
async function urlExists(url) {
    try {
        const res = await openStream(url, 'HEAD')
        res.resume()
        return true
    } catch (err) {
        return false
    }
}

async function downloadToFile(url, destPath) {
    fs.mkdirSync(path.dirname(destPath), { recursive: true })
    const res = await openStream(url)
    await new Promise((resolve, reject) => {
        const file = fs.createWriteStream(destPath)
        res.pipe(file)
        file.on('finish', () => file.close(resolve))
        file.on('error', reject)
        res.on('error', reject)
    })
}

/**
 * Downloads a URL just to compute its MD5 and size (helios-core validates
 * files by MD5, which most APIs do not provide).
 */
async function hashRemoteFile(url) {
    const res = await openStream(url)
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('md5')
        let total = 0
        res.on('data', chunk => { hash.update(chunk); total += chunk.length })
        res.on('end', () => resolve({ size: total, md5: hash.digest('hex') }))
        res.on('error', reject)
    })
}

function hashLocalFile(filePath) {
    const buf = fs.readFileSync(filePath)
    return { size: buf.length, md5: crypto.createHash('md5').update(buf).digest('hex') }
}

/**
 * hashRemoteFile with an on-disk cache keyed by URL, so rebuilding or
 * re-adding a mod never downloads it a second time just to hash it.
 */
let cacheFile = null
let cacheData = null
function setHashCacheFile(file) {
    cacheFile = file
    cacheData = null
}
function loadCache() {
    if (cacheData != null) return cacheData
    cacheData = {}
    try {
        if (cacheFile && fs.existsSync(cacheFile)) {
            cacheData = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'))
        }
    } catch (err) {
        cacheData = {}
    }
    return cacheData
}
async function hashRemoteFileCached(url) {
    const cache = loadCache()
    if (cache[url]) return cache[url]
    const result = await hashRemoteFile(url)
    cache[url] = result
    try {
        if (cacheFile) fs.writeFileSync(cacheFile, JSON.stringify(cache))
    } catch (err) {
        // Cache is best-effort only.
    }
    return result
}

/** Runs fn over items with at most `limit` in flight, preserving order. */
async function mapLimit(items, limit, fn) {
    const results = new Array(items.length)
    let next = 0
    async function worker() {
        while (next < items.length) {
            const i = next++
            results[i] = await fn(items[i], i)
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
    return results
}

module.exports = {
    getText,
    getJson,
    urlExists,
    downloadToFile,
    hashRemoteFile,
    hashRemoteFileCached,
    hashLocalFile,
    setHashCacheFile,
    mapLimit
}
