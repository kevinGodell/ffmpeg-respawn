'use strict';

const { spawn } = require('child_process');
const { Writable } = require('stream');
const { EventEmitter } = require('events');

class FfmpegRespawn extends EventEmitter {
  /**
   *
   * @param options {Object}
   * @param options.params {String[]} - Parameters passed to ffmpeg process.
   * @param [options.pipes] {Writable[]|Function[]} - Array of writable pipes and/or functions to receive data output from ffmpeg stdio[n].
   * @param [options.path=ffmpeg] {String} - Specify path to ffmpeg if it is not in PATH.
   * @param [options.logLevel=quiet] {String} - Valid options: quiet, -8, panic, 0, fatal, 8, error, 16, warning, 24, info, 32, verbose, 40, debug, 48, trace, 56.
   * @param [options.killAfterStall=10] {Number} - Valid range: 10 - 60. Number of seconds to wait to kill ffmpeg process if not receiving progress.
   * @param [options.reSpawnDelay=2] {Number} - Valid range: 2 - 60. Number of seconds to wait to re-spawn ffmpeg process after it exits.
   * @param [options.reSpawnLimit=1] {Number} - Valid range: 0 - Infinity. Number of attempts to re-spawn ffmpeg after exiting without progress. Fail event will be emitted after reaching limit.
   * @param [options.debug=false] {Boolean} - If true, will output some debugging data to console.
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
      if (
        this._params[i] === '-i' &&
        (this._params[i + 1] === 'pipe:0' || this._params[i + 1] === '-' || this._params[i + 1] === 'pipe:')
      ) {
        throw new Error('Params error: stdin/stdio[0]/pipe:0 not supported yet.');
      }
      if (this._params[i] === 'pipe:1' || this._params[i] === 'pipe:' || this._params[i] === '-') {
        throw new Error('Params error: stdout/stdio[1]/pipe:1 is reserved for internal progress monitoring.');
      }
      if (this._params[i] === 'pipe:2') {
        throw new Error('Params error: pipe:2 is reserved, set options.logLevel and listen to "stderr" event instead.');
      }
      if (this._params[i] === '-loglevel') {
        throw new Error(
          'Params error: -loglevel is reserved, set options.logLevel and listen to "stderr" event instead.'
        );
      }
      const results = /pipe:(\d+)/.exec(this._params[i]);
      if (results && results.index === 0) {
        this._stdio[results[1]] = 'pipe';
        paramPipeCount++;
      }
    }

    if (
      paramPipeCount > 0 &&
      (!options.pipes || !Array.isArray(options.pipes) || options.pipes.length !== paramPipeCount)
    ) {
      throw new Error(`Pipes error: must be an array with ${paramPipeCount} item${paramPipeCount === 1 ? '' : 's'}).`);
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
              this._stdioPipes.push({
                stdioIndex: pipe.stdioIndex,
                destination: FfmpegRespawn._createWritable(pipe.destination)
              });
            } else if (pipe.destination instanceof Writable) {
              this._stdioPipes.push(pipe);
            } else {
              throw new Error(
                `Destination: ${pipe.destination} must be a stream(Writable, Duplex, Transform) or a callback function that can receive a single param.`
              );
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
    this._stdioPipes.push({
      stdioIndex: 1,
      destination: FfmpegRespawn._createWritable((data) => {
        this._checkProgress(data);
      })
    });

    //add the progress pipe to front of params array
    this._params.unshift(...['-progress', 'pipe:1']);

    //add 'pipe' to array that will activate stdio[1] from ffmpeg
    this._stdio[1] = 'pipe';

    //check options.logLevel and create pipe to handle output if necessary
    if (FfmpegRespawn._checkLoglevel(options.logLevel)) {
      this._stdioPipes.push({
        stdioIndex: 2,
        destination: FfmpegRespawn._createWritable((data) => {
          this.emit('stderr', data);
        })
      });
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
    const reSpawnDelay = Math.trunc(options.reSpawnDelay);
    if (isNaN(reSpawnDelay) || reSpawnDelay < 2) {
      this._reSpawnDelay = 2000;
    } else if (reSpawnDelay > 60) {
      this._reSpawnDelay = 60000;
    } else {
      this._reSpawnDelay = reSpawnDelay * 1000;
    }

    //set number of failed attempts to respawn, number is reset if progress occurs
    const reSpawnLimit = Math.trunc(options.reSpawnLimit);
    if (Number.isNaN(reSpawnLimit)) {
      this._reSpawnLimit = 1;
    } else if (reSpawnLimit < 0) {
      this._reSpawnLimit = 0;
    } else {
      this._reSpawnLimit = reSpawnLimit;
    }

    //output some details if in debug
    if (options.debug) {
      console.dir(this, { showHidden: true, depth: 2, colors: true });
    }

    return this;
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
   * @returns {String | null}
   */
  get params() {
    return this._params.join(' ') || null;
  }

  /**
   *
   * @readonly
   * @returns {Boolean}
   */
  get running() {
    return this._running || false;
  }

  /**
   *
   * @readonly
   * @return {String | null}
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
      this._stopStallInterval();
      this._stopReSpawnTimer();
      this._kill();
    }
    return this;
  }

  /**
   *
   * Stops process and makes instance unusable
   */
  destroy() {
    this.stop();
    delete this._stdioPipes;
    delete this._progress;
    delete this._reSpawnDelay;
    delete this._params;
    delete this._path;
    delete this._progressTime;
    delete this._reSpawnCounter;
    delete this._reSpawnLimit;
    delete this._running;
    delete this._stdio;
    delete this._killAfterStall;
    this.emit('destroy');
  }

  /**
   *
   * @private
   */
  _spawn() {
    this._ffmpeg = spawn(this._path, this._params, { stdio: this._stdio });
    this._ffmpeg.once('error', (error) => {
      throw error;
    });
    this._ffmpeg.once('exit', (code, signal) => {
      this._onExit(code, signal);
    });
    for (let i = 0; i < this._stdioPipes.length; i++) {
      this._ffmpeg.stdio[this._stdioPipes[i].stdioIndex].pipe(
        this._stdioPipes[i].destination,
        { end: false }
      );
    }
    this._startStallInterval();
  }

  /**
   *
   * @private
   */
  _kill() {
    if (this._ffmpeg) {
      if (this._ffmpeg.kill(0)) {
        for (let i = 0; i < this._stdioPipes.length; i++) {
          const pipe = this._stdioPipes[i];
          this._ffmpeg.stdio[pipe.stdioIndex].unpipe(pipe.destination);
          if (pipe.resetCache && typeof pipe.destination.resetCache === 'function') {
            pipe.destination.resetCache();
          }
        }
        this._ffmpeg.kill(process.platform === 'darwin' || process.platform === 'linux' ? 'SIGHUP' : 'SIGTERM'); //SIGTERM, SIGINT, (SIGHUP fails on Windows, works reliably on macOS)
      }
      delete this._ffmpeg;
      this.emit('kill');
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
    this._stopStallInterval();
    this.emit('exit', code, signal);
    if (this._running === true) {
      if (this._reSpawnCounter >= this._reSpawnLimit) {
        this._running = false;
        this.emit(
          'fail',
          `Ffmpeg unable to get progress from input source after ${this._reSpawnCounter} attempt${
            this._reSpawnCounter === 1 ? '' : 's'
          } at respawning.`
        );
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
      this._progressTime = Date.now();
      this._reSpawnCounter = 0;
      this._progress = string;
      this.emit('progress', object, string);
    } else if (object.progress === 'end') {
      this._progress = string;
      console.log('progress end');
      // todo call stop() ??
    }
  }

  /**
   *
   * @private
   */
  _startStallInterval() {
    this._stopStallInterval();
    this._progressTime = Date.now();
    this._stallInterval = setInterval(() => {
      const elapsed = Date.now() - this._progressTime;
      if (elapsed > this._killAfterStall) {
        this._stopStallInterval();
        this._kill();
      }
    }, 2000);
  }

  /**
   *
   * @private
   */
  _stopStallInterval() {
    if (this._stallInterval) {
      clearInterval(this._stallInterval);
      delete this._stallInterval;
    }
  }

  /**
   *
   * @private
   */
  _startReSpawnTimer() {
    this._stopReSpawnTimer();
    this._spawnTimer = setTimeout(() => {
      this._stopReSpawnTimer();
      this._spawn();
    }, this._reSpawnDelay);
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
    const levels = [
      'quiet',
      '-8',
      'panic',
      '0',
      'fatal',
      '8',
      'error',
      '16',
      'warning',
      '24',
      'info',
      '32',
      'verbose',
      '40',
      'debug',
      '48',
      'trace',
      '56'
    ];
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

module.exports = FfmpegRespawn;

//todo add error event listener to pipes and propagate event out of ffmpeg-respawn instance
