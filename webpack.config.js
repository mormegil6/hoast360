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
        new ESLintPlugin({
            // vendored third-party code (videojs-xr fork) is not linted
            exclude: ['node_modules', 'dependencies/videojs-xr']
        })
    ]
};

module.exports = env => {
    if (env && env.analyze)
        config.plugins.push(new BundleAnalyzerPlugin({ analyzerPort: 8123 }));

    return config;
}
