const fs   = require('fs-extra')
const path = require('path')

/**
 * Ensures the given server appears in the instance's servers.dat file
 * (Minecraft's in-game Multiplayer list), without overwriting or duplicating
 * any servers the player has already added themselves.
 *
 * @param {string} gameDir      Absolute path to the instance's game directory.
 * @param {string} serverName   Display name for the server entry.
 * @param {string} serverAddress The server's address, e.g. 'play.example.com:25565'.
 */
async function ensureServerListed(gameDir, serverName, serverAddress){
    // Lazily require prismarine-nbt only when actually needed, so it doesn't
    // add to the app's startup cost every time the launcher opens.
    const nbt = require('prismarine-nbt')

    const serversDatPath = path.join(gameDir, 'servers.dat')

    let root

    if(await fs.pathExists(serversDatPath)){
        const buf = await fs.readFile(serversDatPath)
        const { parsed } = await nbt.parse(buf)
        root = parsed
    } else {
        root = {
            type: 'compound',
            name: '',
            value: {}
        }
    }

    if(root.value.servers == null){
        root.value.servers = {
            type: 'list',
            value: { type: 'compound', value: [] }
        }
    }

    const list = root.value.servers.value.value || []

    const alreadyListed = list.some(entry => entry.ip && entry.ip.value === serverAddress)

    if(!alreadyListed){
        list.unshift({
            name: { type: 'string', value: serverName },
            ip: { type: 'string', value: serverAddress }
        })
        root.value.servers.value.value = list

        const outBuf = nbt.writeUncompressed(root, 'big')
        await fs.ensureDir(gameDir)
        await fs.writeFile(serversDatPath, outBuf)
    }
}

module.exports = { ensureServerListed }