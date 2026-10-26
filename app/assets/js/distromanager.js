const { DistributionAPI } = require('helios-core/common')

const ConfigManager = require('./configmanager')
const PackLibrary = require('./packs/packlibrary')

// Packs are built locally by the launcher (see assets/js/packs/), so the
// distribution is always read from the local distribution_dev.json that
// PackLibrary maintains - there is no remote distribution to fetch.
const launcherDirectory = ConfigManager.getLauncherDirectory()
PackLibrary.ensureDistribution(launcherDirectory)

const api = new DistributionAPI(
    launcherDirectory,
    null, // Injected forcefully by the preloader.
    null, // Injected forcefully by the preloader.
    '',   // No remote distribution.
    true  // Dev mode: read the local distribution_dev.json.
)

exports.DistroAPI = api
