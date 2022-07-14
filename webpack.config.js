/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//@ts-check

'use strict';

const path = require('path');

/**@type {import('webpack').Configuration}*/
const config = {
    target: 'node', // vscode extensions run in a Node.js-context 📖 -> https://webpack.js.org/configuration/node/

    entry: './src/node/index.ts', // the entry point of this extension, 📖 -> https://webpack.js.org/configuration/entry-context/
    output: {
        // the bundle is stored in the 'dist' folder (check package.json), 📖 -> https://webpack.js.org/configuration/output/
        path: path.resolve(__dirname, 'dist/node'),
        filename: 'index.js',
        libraryTarget: 'commonjs2',
        devtoolModuleFilenameTemplate: '../[resource-path]'
    },
    devtool: 'source-map',
    resolve: {
        // support reading TypeScript and JavaScript files, 📖 -> https://github.com/TypeStrong/ts-loader
        extensions: ['.ts', '.js']
    },
    externals: [
        {
            vscode: 'commonjs vscode'
        },
        function ({ context, request }, callback) {
            if (request && request.startsWith('vscode-')) {
                // Externalize to a commonjs module using the request path
                return callback(null, 'commonjs ' + request);
            }

            // Continue without externalizing the import
            callback();
        }
    ],
    module: {
        rules: [
            {
                test: /\.ts$/,
                use: [
                    {
                        loader: 'ts-loader',
                        options: {
                            compilerOptions: {
                                module: 'es6', // override `tsconfig.json` so that TypeScript emits native JavaScript modules.
                                declarationDir: 'dist'
                            },
                            transpileOnly: false,
                            happyPackMode: false
                        }
                    }
                ]
            }
        ]
    }
};

module.exports = config;
