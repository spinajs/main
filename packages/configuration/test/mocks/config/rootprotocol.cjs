// ROOT-level protocol var - regression guard: root-level ConfigVars must stay
// lazy ( see configuration.load() root proxy handling )
module.exports = {
    rootLazy: "lazyroot://sampleval",
};
