'use strict';

const { spawn } = require('child_process');
const { Writable } = require('stream');
const { EventEmitter } = require('events');

class FfmpegRespawn extends EventEmitter {
    /**
     *
     * @param options {Object}
     * @param options.params {String[]} - Parameters passed to ffmpeg process.
     * @param [options.pipes] {Writable[]|Function[]} - Array of writable pipes and/or callback functions to receive data output from ffmpeg stdio[n].
     * @param [options.path=ffmpeg] {String} - Specify path to ffmpeg if it is not in PATH.
     * @param [options.logLevel=quiet] {String} - Valid options: quiet, -8, panic, 0, fatal, 8, error, 16, warning, 24, info, 32, verbose, 40, debug, 48, trace, 56.
     * @param [options.stderrLogs] {Function|Writable} - Callback function or writable pipe to receive logging from stderr as buffer when options.loglevel is > -8(quiet). If logging is set without passing callback or pipe, output will be sent to console.
     * @param [options.exitCallback] {Function} - Callback function called when ffmpeg process exits. Contains code and signal. Exit event will be emitted if callback is not used.
     * @param [options.killAfterStall=10] {Number} - Valid range: 10 - 60. Number of seconds to wait to kill ffmpeg process if not receiving progress.
     * @param [options.spawnAfterExit=2] {Number} - Valid range: 2 - 60. Number of seconds to wait to re-spawn ffmpeg process after it exits.
     * @param [options.reSpawnLimit=1] {Number} - Valid range: 0 - Infinity. Number of attempts to re-spawn ffmpeg after exiting without progress. Fail event will be emitted after reaching limit.
     * @returns {FfmpegRespawn}
     */
    constructor(options) {
        super();

        //options are required on instantiation
        if (!options) {
            throw new Error('Options error: must pass a configuration object');
        }

        //check that params is array and has a minimum number of items
        if (!options.params || !Array.isArray(options.params) || options.params.length < 3) {
            throw new Error('Params error: must be an array with a minimum of 3 items.');
        }

        //set params property since it met the bare minimum
        this._params = options.params;

        //set defaults that will be passed to spawned ffmpeg, will update when looping through params
        this._stdio = ['ignore', 'ignore', 'ignore', 'ignore'];

        let paramPipeCount = 0;

        //loop through params and configure pipes
        for (let i = 0; i < this._params.length; i++) {
            if (this._params[i] === '-i' && (this._params[i + 1] === 'pipe:0' || this._params[i + 1] === '-' || this._params[i + 1] === 'pipe:')) {
                throw new Error('Params error: stdin/stdio[0]/pipe:0 not supported yet.');
            }
            if (this._params[i] === 'pipe:2') {
                throw new Error('Params error: pipe:2 is reserved, set options.logLevel and options.stderrLogs instead.');
            }
            if (this._params[i] === 'pipe:3') {
                throw new Error('Params error: pipe:3 is reserved for internal progress monitoring.');
            }
            if (this._params[i] === '-loglevel') {
                throw new Error('Params error: -loglevel is reserved, set options.logLevel and options.stderrLogs instead.');
            }
            if (this._params[i] === 'pipe:1' || this._params[i] === 'pipe:' || this._params[i] === '-') {
                this._stdio[1] = 'pipe';
                paramPipeCount++;
            } else {
                const results = /pipe:(\d+)/.exec(this._params[i]);
                if (results && results.index === 0) {
                    this._stdio[results[1]] = 'pipe';
                    paramPipeCount++;
                }
            }
        }

        if (paramPipeCount > 0 && (!options.pipes || !Array.isArray(options.pipes) || options.pipes.length !== paramPipeCount)) {
            throw new Error(`Pipes error: must be an array with ${paramPipeCount} item(s).`);
        }

        //create temp variable to hold array
        const pipes = options.pipes;

        //will be used to keep track of pipes passed to spawned ffmpeg process
        this._stdioPipes = [];

        //test if any pipes were skipped in options.params, and process options.pipes
        for (let i = 0; i < this._stdio.length; i++) {
            if (this._stdio[i] === undefined) {
                throw new Error(`Params error: pipe:${i} was skipped.`);
            }
            if (this._stdio[i] === 'pipe') {
                let foundPipe = false;
                for (let j = 0; j < pipes.length; j++) {
                    if (pipes[j].stdioIndex === i) {
                        const pipe = pipes[j];
                        if (typeof pipe.destination === 'function' && pipe.destination.length > 0) {
                            this._stdioPipes.push({stdioIndex: pipe.stdioIndex, destination: FfmpegRespawn._createWritable(pipe.destination)});
                        } else if (pipe.destination instanceof Writable) {
                            this._stdioPipes.push(pipe);
                        } else {
                            throw new Error(`Destination: ${pipe.destination} must be a stream(Writable, Duplex, Transform) or a callback function that can receive a single param.`);
                        }
                        foundPipe = true;
                    }
                }
                if (!foundPipe) {
                    throw new Error(`Pipes error: pipes array did not have a matching pipe or callback for pipe:${i}.`);
                }
            }
        }

        //create and add the progress pipe to our stdioPipes array
        this._stdioPipes.push({stdioIndex: 3, destination: FfmpegRespawn._createWritable(this._checkProgress.bind(this))});

        //add the progress pipe to front of params array
        this._params.unshift(...['-progress', 'pipe:3']);

        //add 'pipe' to array that will activate stdio[3] from ffmpeg
        this._stdio[3] = 'pipe';

        //check options.logLevel and create pipe to handle output if necessary
        if (FfmpegRespawn._checkLoglevel(options.logLevel)) {
            if (typeof options.stderrLogs === 'function' && options.stderrLogs.length > 0) {
                this._stdioPipes.push({stdioIndex: 2, destination: FfmpegRespawn._createWritable(options.stderrLogs)});
            } else if (options.stderrLogs instanceof Writable) {
                this._stdioPipes.push({stdioIndex: 2, destination: options.stderrLogs});
            } else {
                this._stdioPipes.push({stdioIndex: 2, destination: FfmpegRespawn._createWritable(data => console.log(`stderr:${data}`))});
            }
            this._params.unshift(...['-loglevel', options.logLevel]);
            this._stdio[2] = 'pipe';
        } else {
            this._params.unshift(...['-loglevel', 'quiet']);
        }

        //optional, path to ffmpeg
        if (options.path) {
            this._path = options.path;
        } else {
            this._path = 'ffmpeg';
        }

        //optional, function to be called when internal ffmpeg process exits, but before it is respawned
        if (options.exitCallback && typeof options.exitCallback === 'function') {
            this._exitCallback = options.exitCallback;
        }

        //configure number of seconds that passes without progress before killing ffmpeg process
        const killAfterStall = Math.trunc(options.killAfterStall);
        if (isNaN(killAfterStall) || killAfterStall < 10) {
            this._killAfterStall = 10000;
        } else if (killAfterStall > 60) {
            this._killAfterStall = 60000;
        } else {
            this._killAfterStall = killAfterStall * 1000;
        }

        //configure time to wait before re spawning ffmpeg after exiting
        const spawnAfterExit = Math.trunc(options.spawnAfterExit);
        if (isNaN(spawnAfterExit) || spawnAfterExit < 2) {
            this._spawnAfterExit = 2000;
        } else if (spawnAfterExit > 60) {
            this._spawnAfterExit = 60000;
        } else {
            this._spawnAfterExit = spawnAfterExit * 1000;
        }

        //set number of failed attempts to respawn, number is reset if progress occurs
        const reSpawnLimit = Math.trunc(options.reSpawnLimit);
        if (Number.isNaN(reSpawnLimit)) {
            this._reSpawnLimit = 1;
        } else if (reSpawnLimit < 0) {
            this._reSpawnLimit = 0;
        } else {
            this._reSpawnLimit = reSpawnLimit
        }

        //output some details if in development
        if (process.env.NODE_ENV === 'development') {
            console.log(this._stdio);
            console.log(this._stdioPipes);
            console.log(this._params);
        }

        //seems to not be needed
        return this;

        //todo check stdin for readable stream
    }

    /**
     *
     * @readonly
     * @return {*|null}
     */
    get ffmpeg() {
        return this._ffmpeg || null;
    }

    /**
     *
     * @readonly
     * @return {*}
     */
    get stdio() {
        return this._ffmpeg && this._ffmpeg.stdio ? this._ffmpeg.stdio : null;
    }

    /**
     *
     * @readonly
     * @returns {string | null}
     */
    get params() {
        return this._params.join(' ') || null;
    }

    /**
     *
     * @readonly
     * @returns {boolean}
     */
    get running() {
        return this._running || false;
    }

    /**
     *
     * @return {string | null}
     */
    get progress() {
        return this._progress || null;
    }

    /**
     *
     * @returns {FfmpegRespawn}
     */
    start() {
        if (this._running !== true) {
            this._running = true;
            this._reSpawnCounter = 0;
            this._spawn();
        }
        return this;
    }

    /**
     *
     * @returns {FfmpegRespawn}
     */
    stop() {
        if (this._running === true) {
            this._running = false;
            this._stopStallTimer();
            this._stopReSpawnTimer();
            this._kill();
        }
        return this;
    }

    /**
     *
     * @private
     */
    _spawn() {
        this._ffmpeg = spawn(this._path, this._params, {stdio: this._stdio});
        this._ffmpeg.once('error', (error)=> {
            throw error;
        });
        this._ffmpeg.once('exit', this._onExit.bind(this));
        for (let i = 0; i < this._stdioPipes.length; i++) {
            this._ffmpeg.stdio[this._stdioPipes[i].stdioIndex].pipe(this._stdioPipes[i].destination, {end: false});
        }
        this._startStallTimer();
    }

    /**
     *
     * @private
     */
    _kill() {
        if (this._ffmpeg) {
            if (this._ffmpeg.kill(0)) {
                for (let i = 0; i < this._stdioPipes.length; i++) {
                    this._ffmpeg.stdio[this._stdioPipes[i].stdioIndex].unpipe(this._stdioPipes[i].destination);
                }
                this._ffmpeg.kill(process.platform === 'darwin' || process.platform === 'linux' ? 'SIGHUP' : 'SIGTERM');//SIGTERM, SIGINT, (SIGHUP fails on Windows, works reliably on macOS)
            }
            delete this._ffmpeg;
        }
    }

    /**
     *
     * @param code
     * @param signal
     * @private
     */
    _onExit(code, signal) {
        this._kill();
        this._stopStallTimer();
        if (this._exitCallback) {
            this._exitCallback(code, signal);
        } else {
            this.emit('exit', code, signal);
        }
        if (this._running === true) {
            if (this._reSpawnCounter >= this._reSpawnLimit) {
                this._running = false;
                this.emit('fail', `Ffmpeg unable to get progress from input source after ${this._reSpawnCounter} attempts at respawning.`);
            } else {
                this._reSpawnCounter++;
                this._startReSpawnTimer();
            }
        }
    }

    /**
     *
     * @param chunk
     * @private
     */
    _checkProgress(chunk) {
        const string = chunk.toString();
        const array = string.split('\n').slice(0, -1);
        const object = {};
        for (let i = 0; i < array.length; i++) {
            const tempArr = array[i].split('=');
            object[tempArr[0]] = tempArr[1].trimLeft();
        }
        if (object.progress === 'continue') {
            this._startStallTimer();
            this._reSpawnCounter = 0;
            this._progress = string;
            this.emit('progress', object, string);
        } else if (object.progress === 'end') {
            this._progress = string;
            console.log('progress end');
        }
    }

    /**
     *
     * @private
     */
    _onStallTimer() {
        this._stopStallTimer();
        this._kill();
    }

    /**
     *
     * @private
     */
    _startStallTimer() {
        if (this._stallTimer) {
            clearTimeout(this._stallTimer);
        }
        this._stallTimer = setTimeout(this._onStallTimer.bind(this), this._killAfterStall);
    }

    /**
     *
     * @private
     */
    _stopStallTimer() {
        if (this._stallTimer) {
            clearTimeout(this._stallTimer);
            delete this._stallTimer;
        }
    }

    /**
     *
     * @private
     */
    _onReSpawnTimer() {
        this._stopReSpawnTimer();
        this._spawn();
    }

    /**
     *
     * @private
     */
    _startReSpawnTimer() {
        if (this._spawnTimer) {
            clearTimeout(this._spawnTimer);
        }
        this._spawnTimer = setTimeout(this._onReSpawnTimer.bind(this), this._spawnAfterExit);
    }

    /**
     *
     * @private
     */
    _stopReSpawnTimer() {
        if (this._spawnTimer) {
            clearTimeout(this._spawnTimer);
            delete this._spawnTimer;
        }
    }

    /**
     *
     * @param level
     * @return {boolean}
     * @private
     */
    static _checkLoglevel(level) {
        const levels = ['quiet', '-8', 'panic', '0', 'fatal', '8', 'error', '16', 'warning', '24', 'info', '32', 'verbose', '40', 'debug', '48', 'trace', '56'];
        return levels.indexOf(level) > 1;
    }

    /**
     *
     * @param destination
     * @return {Writable}
     * @private
     */
    static _createWritable(destination) {
        return new Writable({
            write(chunk, encoding, callback) {
                destination(chunk);
                callback();
            }
        });
    }
}

/**
 *
 * @type {FfmpegRespawn}
 */
module.exports = FfmpegRespawn;

//todo add error event listener to pipes and propagate event out of ffmpeg-respawn instance