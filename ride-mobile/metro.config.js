// Learn more: https://docs.expo.dev/guides/customizing-metro
const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

// The shared domain logic lives in the web app's folder (../ride-app/src/lib).
// Metro only bundles files it watches, so add that folder explicitly.
config.watchFolders = [...(config.watchFolders ?? []), path.resolve(__dirname, "../ride-app/src/lib")];

module.exports = config;
