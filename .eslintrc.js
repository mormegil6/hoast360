module.exports = {
    "env": {
        "browser": true,
        "es6": true
    },
    "extends": "eslint:recommended",
    "ignorePatterns": ["dist/", "dependencies/videojs-xr/"],
    "globals": {
        "Atomics": "readonly",
        "SharedArrayBuffer": "readonly"
    },
    "parserOptions": {
        "ecmaVersion": 2022,
        "sourceType": "module"
    },
    "rules": {
    }
};