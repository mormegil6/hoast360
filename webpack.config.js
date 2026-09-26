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


// The WASM Opus decoder ships under a name that carries a hash of its content.
// /dist/ is cached for hours by the CDN and by browsers, under a URL with no
// ?v=, so a changed file under an unchanged name would be served stale to a
// page running a different app bundle. dependencies/WasmOpusBackend.js reads
// the name from __OPUS_DECODER_FILE__, so the two can never disagree.
const fs = require('fs');
const path = require('path');
const OPUS_DECODER_SRC = path.join(__dirname, 'node_modules/opus-decoder/dist/opus-decoder.min.js');
const OPUS_DECODER_FILE = 'opus-decoder.'
    + require('crypto').createHash('md5').update(fs.readFileSync(OPUS_DECODER_SRC)).digest('hex').slice(0, 8)
    + '.js';

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
            'dashjs$': 'dashjs/dist/dash.all.debug.js',
            // Bundle contrib-dash's SRC, not its dist. The dist inlines a full
            // dash.js 4.2.0 with no ManagedMediaSource support, so the comment
            // above ("keeps every import 'dashjs' on one instance") was never
            // true for the video path: it rode the fossil while the patched
            // 4.7.4 drove only the unused separate-audio player. The src does
            // `import 'dashjs'`, lands on the alias above, and iPhone playback
            // (probe run wwzdd2) exists because of it. The patch's dist hunks
            // (the live-WebM timeline fix 4.2.0 needed) still apply to
            // node_modules but no longer ship: 4.7.4 has that fix upstream.
            'videojs-contrib-dash$': 'videojs-contrib-dash/src/js/videojs-dash.js'
        }
    },
    plugins: [
        new (require('webpack').DefinePlugin)({
            __HOAST_BUILD__: JSON.stringify(BUILD),
            __OPUS_DECODER_FILE__: JSON.stringify(OPUS_DECODER_FILE),
        }),
        new ESLintPlugin({
            // vendored third-party code (the videojs-xr fork) is not linted
            exclude: ['node_modules', 'dependencies/videojs-xr']
        }),
        // The WASM Opus decoder must reach dist VERBATIM: it embeds its binary
        // as a yEnc string that any re-encoding pass corrupts, so it is copied,
        // never bundled. The file is the published opus-decoder package's own
        // dist (pinned exactly in package.json), emitted under a hashed name
        // with its licence notices beside it (the package carries neither
        // libopus's BSD notice nor the MIT text). See
        // dependencies/WasmOpusBackend.js.
        {
            apply(compiler) {
                compiler.hooks.thisCompilation.tap('CopyOpusDecoder', (compilation) => {
                    compilation.hooks.processAssets.tap(
                        { name: 'CopyOpusDecoder', stage: compiler.webpack.Compilation.PROCESS_ASSETS_STAGE_ADDITIONAL },
                        () => {
                            const src = fs.readFileSync(OPUS_DECODER_SRC);
                            compilation.emitAsset(OPUS_DECODER_FILE,
                                new compiler.webpack.sources.RawSource(src),
                                // already-final: terser re-encoding the yEnc
                                // string is the exact corruption this guards
                                { minimized: true });
                            compilation.emitAsset('opus-decoder.LICENSE.txt',
                                new compiler.webpack.sources.RawSource(
                                    fs.readFileSync(path.join(__dirname, 'dependencies/opus-decoder.LICENSE.txt'))),
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
