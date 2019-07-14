'use strict';

process.env.NODE_ENV = 'development';

process.on('uncaughtException', (data) => {
  console.log('uncaughtException', data);
});

const FR = require('..');

const Mp4Frag = require('mp4frag');

const Pipe2Jpeg = require('pipe2jpeg');

const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;

const db = require('./db');

const map = new Map();

for (let i = 0; i < db.length; ++i) {
  let item = { status: 'unknown' };

  const id = db[i].id;

  map.set(id, item);

  try {
    const mp4frag = new Mp4Frag({ hlsBase: db[i].hlsBase, hlsListSize: db[i].hlsListSize });

    mp4frag.on('initialized', (data) => {
      console.log(id, 'mp4 initialized', data);
    });

    mp4frag.on('segment', (segment) => {
      console.log(id, 'mp4 segment', segment.length);
    });

    mp4frag.on('error', (error) => {
      console.log(id, 'mp4 error ', error);
    });

    const pipe2jpeg = new Pipe2Jpeg();

    pipe2jpeg.on('jpeg', (data) => {
      console.log(id, 'jpeg', data.length);
    });

    const ffmpeg = new FR({
      //trigger debug output to console
      debug: false,
      //path to ffmpeg, only needed if not in PATH
      path: ffmpegPath,
      //set loglevel, this value will get passed to ffmpeg -loglevel
      logLevel: db[i].logLevel,
      //detecting no activity for n amount of seconds will cause ffmpeg to be killed
      killAfterStall: 10,
      //ffmpeg will automatically be re-spawned if exiting, delayed by n amount of seconds
      reSpawnDelay: 5,
      //number of time to re-spawn after exiting with no progress
      reSpawnLimit: 3,
      //parameters that will be pass to spawned ffmpeg process
      params: db[i].params,
      //pipes should match the pipes used in params, can be a writable stream or callback function
      //todo allow array of stackable pipes to be passed
      pipes: [
        { stdioIndex: 3, destination: mp4frag, resetCache: true },
        { stdioIndex: 4, destination: pipe2jpeg, resetCache: true }
      ]
    })
      .on('progress', (obj, str) => {
        //console.log('progress\n', obj);
      })
      .on('stderr', (data) => {
        //console.log('stderr', data.toString());
      })
      .on('exit', (code, signal) => {
        console.log(id, 'exit', code, signal);
        item.status = 'exit';
      })
      .on('kill', () => {
        console.log(id, 'kill');
        item.status = 'kill';
      })
      .on('fail', (data) => {
        console.log(id, 'fail', data);
        item.status = 'fail';
      })
      .on('destroy', (data) => {
        console.log(id, 'destroy');
        item.status = 'destroy';
      })
      .start();

    item.status = ffmpeg.running ? 'running' : 'stopped';
    item.ffmpeg = ffmpeg;
    item.mp4frag = mp4frag;
    item.pipe2jpeg = pipe2jpeg;
  } catch (err) {
    console.error(err.message);
    item.status = 'error';
    item.message = err.message;
  }
}

setTimeout(() => {
  console.log('time out triggering .stop()');
  map.get('one').ffmpeg.stop();
}, 10000);

setTimeout(() => {
  console.log('time out triggering .start()');
  map.get('one').ffmpeg.start();
}, 15000);

setTimeout(() => {
  console.log('time out triggering .destory() and .delete()');
  let item = map.get('one');
  item.ffmpeg.destroy();
  item = null;
  console.log('map size before', map.size);
  map.delete('one');
  console.log('map size after', map.size);
}, 20000);

setTimeout(() => {
  console.log('time out triggering .destroy() and .delete()');
  let item = map.get('two');
  console.log('status before', item.status);
  if (item.ffmpeg) {
    item.ffmpeg.destroy();
  }
  console.log('status after', item.status);
  //item.ffmpeg.destroy();
  item = null;
  console.log('map size before', map.size);
  map.delete('two');
  console.log('map size after', map.size);
}, 25000);
