// Build stamp, so a page can always say WHICH build it is running - a test
// session spent minutes unsure whether it was hearing the old or new bundle.
const { execSync } = require('child_process');
let BUILD = 'unknown';
try {
    BUILD = execSync('git describe --always --dirty', { cwd: __dirname }).toString().trim()
        // LOCAL time, not toISOString(): the stamp is read off the screen next
        // to a wall clock, and a UTC stamp read as two hours slow.
        + ' ' + new Date().toLocaleString('sv-SE').slice(0, 16);
} catch (e) { /* no git: stays unknown */ }


const ESLintPlugin = require('eslint-webpack-plugin');
const BundleAnalyzerPlugin = require('webpack-bundle-analyzer').BundleAnalyzerPlugin;

const config = {
    entry: './hoast360.js',
    output: {
        filename: 'hoast360.bundle.js',
        library: {
            type: 'umd'
        }
    },
    module: {
        rules: [
            {
                test: /\.m?js$/,
                exclude: /(node_modules|bower_components)/,
                use: {
                    loader: 'babel-loader',
                    options: {
                        presets: ['@babel/preset-env']
                    }
                }
            },
            {
                test: /\.css$/i,
                use: ['style-loader', 'css-loader']
            }
        ]
    },
    resolve: {
        extensions: ['.js'],
        alias: {
            // Bundle the readable debug build instead of the prebuilt min:
            // patches/dashjs+4.7.4.patch (applied by patch-package) fixes live
            // WebM crashes there, and reviewing a patch against the minified
            // single-line build would be impossible. Production mode
            // re-minifies via terser, and the single alias keeps every
            // `import 'dashjs'` (incl. videojs-contrib-dash) on one instance.
            'dashjs$': 'dashjs/dist/dash.all.debug.js'
        }
    },
    plugins: [
        new (require('webpack').DefinePlugin)({ __HOAST_BUILD__: JSON.stringify(BUILD) }),
        new ESLintPlugin({
            // vendored third-party code (videojs-xr fork, and the opus-decoder
            // runtime bundle) is not linted
            exclude: ['node_modules', 'dependencies/videojs-xr', 'dependencies/opus-decoder.bundle.js']
        }),
        // The WASM Opus decoder must reach dist VERBATIM: it embeds its binary
        // as a yEnc string that any re-encoding pass corrupts, so it is copied,
        // never bundled. See dependencies/WasmOpusBackend.js.
        {
            apply(compiler) {
                compiler.hooks.thisCompilation.tap('CopyOpusDecoder', (compilation) => {
                    compilation.hooks.processAssets.tap(
                        { name: 'CopyOpusDecoder', stage: compiler.webpack.Compilation.PROCESS_ASSETS_STAGE_ADDITIONAL },
                        () => {
                            const fs = require('fs'), path = require('path');
                            const src = fs.readFileSync(path.join(__dirname, 'dependencies/opus-decoder.bundle.js'));
                            compilation.emitAsset('opus-decoder.bundle.js',
                                new compiler.webpack.sources.RawSource(src),
                                // already-final: terser re-encoding the yEnc
                                // string is the exact corruption this guards
                                { minimized: true });
                        });
                });
            }
        }
    ]
};

module.exports = env => {
    if (env && env.analyze)
        config.plugins.push(new BundleAnalyzerPlugin({ analyzerPort: 8123 }));

    return config;
}
