'use strict';

const { spawn } = require('child_process');
const { Writable } = require('stream');
const { EventEmitter } = require('events');

class FfmpegRespawn extends EventEmitter {
    /**
     *
     * @param options
     * @param options.params
     * @param options.pipes
     * @param options.path
     * @param options.exitCallback
     * @param options.logCallback
     * @param options.killAfterStall
     * @param options.spawnAfterExit
     * @param options.reSpawnLimit
     * @returns {FfmpegRespawn}
     */
    constructor(options) {
        super();

        //options are required on instantiation
        if (!options) {
            throw new Error('Must pass a configuration object');
        }

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
                throw new Error('Params error: "pipe:2" is reserved for ffmpeg logging to callback.');
            }
            if (this._params[i] === 'pipe:3') {
                throw new Error('Params error: "pipe:3" is reserved for progress monitoring.');
            }
            //this._params[i] === '-loglevel' && this._params[i + 1] !== 'quiet' && this._params[i + 1] !== '-8'
            if (this._params[i] === '-loglevel') {
                throw new Error('Params error: "-loglevel" is not supported, set options.loglevel instead.');
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
            throw new Error(`Pipes error: options.pipes should contain a pipes/callback count of ${paramPipeCount}.`);
        }

        //create temp variable to hold array
        const pipes = options.pipes;

        //will be used to keep track of pipes passed to spawned ffmpeg process
        this._stdioPipes = [];

        //test if any pipes were skipped in options.params, and process options.pipes
        for (let i = 0; i < this._stdio.length; i++) {
            if (this._stdio[i] === undefined) {
                throw new Error(`Params error: "pipe:${i}" was skipped.`);
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
                            throw new Error(`Destination: "${pipe.destination}" must be a stream instance of Writable, Duplex, or Transform or a function that can receive a single param.`);
                        }
                        foundPipe = true;
                    }
                }
                if (!foundPipe) {
                    throw new Error(`Pipes error: options.pipes did not have a matching pipe or callback for pipe:${i}.`);
                }
            }
        }

        //create and add the progress pipe to our stdioPipes array
        this._stdioPipes.push({stdioIndex: 3, destination: FfmpegRespawn._createWritable(this._onProgress.bind(this))});

        //add the progress pipe to front of params array
        this._params.unshift(...['-progress', 'pipe:3']);

        //add 'pipe' to array that will activate stdio[3] from ffmpeg
        this._stdio[3] = 'pipe';

        //todo move loglevel to options
        //if (options.loglevel) {
        //console.log(options.loglevel);
        //}

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
        const killAfterStall = parseInt(options.killAfterStall);
        if (isNaN(killAfterStall) || killAfterStall < 10) {
            this._killAfterStall = 10000;
        } else if (killAfterStall > 60) {
            this._killAfterStall = 60000;
        } else {
            this._killAfterStall = killAfterStall * 1000;
        }

        //configure time to wait before re spawning ffmpeg after exiting
        const spawnAfterExit = parseInt(options.spawnAfterExit);
        if (isNaN(spawnAfterExit) || spawnAfterExit < 2) {
            this._spawnAfterExit = 2000;
        } else if (spawnAfterExit > 60) {
            this._spawnAfterExit = 60000;
        } else {
            this._spawnAfterExit = spawnAfterExit * 1000;
        }

        //set number of failed attempts to respawn, number is reset if progress occurs
        const reSpawnLimit = parseInt(options.reSpawnLimit);
        if (isNaN(reSpawnLimit) || reSpawnLimit < 1) {
            this._reSpawnLimit = 1;
        } else if (reSpawnLimit > 10000) {
            this._reSpawnLimit = 10000;
        } else {
            this._reSpawnLimit = reSpawnLimit;
        }

        //output some details if in development
        if (process.env.NODE_ENV === 'development') {
            console.log(this._stdio);
            console.log(this._stdioPipes);
            console.log(this._params);
        }

        return this;// not needed
        //todo check stdin for readable stream
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
     * @returns {FfmpegRespawn}
     */
    start() {
        if (this._running !== true) {
            this._running = true;
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
            this._stopSpawnTimer();
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
            //this.kill();
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
                this._ffmpeg.kill('SIGHUP');//SIGTERM, SIGINT
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
        if (this._running === true) {
            this._exitCounter = this._exitCounter + 1 || 1;
            if (this._exitCounter >= this._reSpawnLimit) {
                throw new Error(`Dispatch "fail" event after ${this._exitCounter} failed attempt(s)`);
                //todo emit fail event
            } else {
                this._startSpawnTimer();
            }
        }
        if (this._exitCallback) {
            this._exitCallback();
        } else {
            this.emit('exit', code, signal);
        }
    }

    /**
     *
     * @param object
     * @private
     */
    _onProgress(chunk) {
        const array = chunk.toString().split('\n').slice(0, -1);
        const object = {};
        for (let i = 0; i < array.length; i++) {
            const tempArr = array[i].split('=');
            object[tempArr[0]] = tempArr[1].trimLeft();
        }
        if (object.progress === 'continue') {
            this._startStallTimer();
            this._exitCounter = 0;
        } else if (object.progress === 'end') {
            console.log('progress end');
        }
    }

    /**
     *
     * @private
     */
    _onStall() {
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
        this._stallTimer = setTimeout(this._onStall.bind(this), this._killAfterStall);
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
    _onSpawn() {
        this._stopSpawnTimer();
        this._spawn();
    }

    /**
     *
     * @private
     */
    _startSpawnTimer() {
        if (this._spawnTimer) {
            clearTimeout(this._spawnTimer);
        }
        this._spawnTimer = setTimeout(this._onSpawn.bind(this), this._spawnAfterExit);
    }

    /**
     *
     * @private
     */
    _stopSpawnTimer() {
        if (this._spawnTimer) {
            clearTimeout(this._spawnTimer);
            delete this._spawnTimer;
        }
    }

    /**
     *
     * @param destination
     * @return {"stream".internal.Writable}
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