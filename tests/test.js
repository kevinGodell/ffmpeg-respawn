/* jshint nonew: false */

'use strict';

console.time('=====> test.js');

process.env.NODE_ENV = 'development';

const FfmpegRespawn = require('../index');

const assert = require('assert');

const { Writable } = require('stream');

const writable = new Writable({
    write(chunk, encoding, callback) {
        callback();
    }
});

assert(new FfmpegRespawn({params: ['-i', 'in', 'out']}).params === '-loglevel quiet -progress pipe:3 -i in out');

assert.throws(
    () => {
        new FfmpegRespawn({params: null});
    },
    /Params error: must be an array with a minimum of 3 items./
);

assert.throws(
    () => {
        new FfmpegRespawn({params:['-i', 'in', 'pipe:2']});
    },
    /Params error: pipe:2 is reserved, set options.logLevel and options.stderrLogs instead./
);

assert.throws(
    () => {
        new FfmpegRespawn({params:['-i', 'in', 'pipe:3']});
    },
    /Params error: pipe:3 is reserved for internal progress monitoring./
);

assert.throws(
    () => {
        new FfmpegRespawn({params:['-i', 'pipe:0', 'out']});
    },
    /Params error: stdin\/stdio\[0]\/pipe:0 not supported yet/
);

assert.throws(
    () => {
        new FfmpegRespawn({params:['-i', 'pipe:', 'out']});
    },
    /Params error: stdin\/stdio\[0]\/pipe:0 not supported yet./
);

assert.throws(
    () => {
        new FfmpegRespawn({params:['-i', '-', 'out']});
    },
    /Params error: stdin\/stdio\[0]\/pipe:0 not supported yet./
);

assert.throws(
    () => {
        new FfmpegRespawn({params: ['-i', 'in', 'pipe:1'], pipes: [{stdioIndex: 4, destination: writable}]});
    },
    /Pipes error: pipes array did not have a matching pipe or callback for pipe:1./
);

assert.throws(
    () => {
        new FfmpegRespawn({params: ['-i', 'in', 'pipe:1'], pipes: [{stdioIndex: 1, destination: null}]});
    },
    /Destination: null must be a stream\(Writable, Duplex, Transform\) or a callback function that can receive a single param./
);

//todo throw error if we don not have enough pipes to match all that were passed in params

console.timeEnd('=====> test.js');