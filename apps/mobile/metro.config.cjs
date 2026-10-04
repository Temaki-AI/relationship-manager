const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
const repositoryRoot = path.resolve(__dirname, '../..');
config.watchFolders = [...config.watchFolders, repositoryRoot];
const escapedRoot = repositoryRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
config.resolver.blockList = [...config.resolver.blockList,
  new RegExp(`^${escapedRoot}/(?:node_modules|\\.next|\\.open-next|\\.wrangler)/`)];
// Shared domain code must resolve the native dependency tree, not Next's React.
config.resolver.disableHierarchicalLookup = true;
config.resolver.nodeModulesPaths = [path.resolve(__dirname, 'node_modules')];
module.exports = config;
