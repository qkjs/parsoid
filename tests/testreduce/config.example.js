/**
 * Example configuration for the testreduce client.js script
 * Copy this file to config.js and change the values as needed.
 */
'use strict';
var path = require('path');

(function() {
	if (typeof module === 'object') {
		module.exports = {
			server: {
				// The address of the master HTTP server (for getting titles and posting results) (no protocol)
				host: 'localhost',

				// The port where the server is running
				port: 8002,
			},

			// A unique name for this client (optional) (URL-safe characters only)
			clientName: 'Parsoid RT testing client',

			opts: {
				// By default, use the same configuration as the testing Parsoid server.
				parsoidConfig: path.resolve(__dirname, '../rttest.localsettings.js'),

				// The parsoid API to use. If null, create our own server
				parsoidURL: null,
			},

			runTest: require('./rtTestWrapper.js').runRoundTripTest,

			// Path of the git repo
			gitRepoPath: path.resolve(__dirname, '../..'),
		};
	}
}());
