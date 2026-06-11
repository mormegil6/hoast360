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
