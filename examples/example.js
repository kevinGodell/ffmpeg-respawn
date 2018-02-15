'use strict';

process.env.NODE_ENV = 'development';

const FR = require('../index');

const Mp4Frag = require('mp4frag');

const Pipe2Pam = require('pipe2pam');

const PamDiff = require('pam-diff');

const ffmpegPath = require('ffmpeg-static').path;

const pipe2pam = new Pipe2Pam();

let count = 0;

/*const { PassThrough } = require('stream');

const myPass = new PassThrough({
    //objectMode: false,
    writableObjectMode: true,
    transform(chunk, encoding, callback) {
        console.log(chunk);
        console.log(mp4frag.mime);
        callback();
    }
});*/

pipe2pam.on('pam', (data)=> {
    console.log('pam', data.width, data.height, data.depth, data.maxval, data.tupltype);
    //console.log(++count);
});

const region1 = {name: 'region1', difference: 6, percent: 1, polygon: [{x: 0, y: 0}, {x: 0, y: 273}, {x: 100, y: 273}, {x: 100, y: 0}]};

const region2 = {name: 'region2', difference: 6, percent: 1, polygon: [{x: 100, y: 0}, {x: 100, y: 273}, {x: 200, y: 273}, {x: 200, y: 0}]};

const region3 = {name: 'region3', difference: 6, percent: 1, polygon: [{x: 200, y: 0}, {x: 200, y: 273}, {x: 300, y: 273}, {x: 300, y: 0}]};

const region4 = {name: 'region4', difference: 6, percent: 1, polygon: [{x: 300, y: 0}, {x: 300, y: 273}, {x: 400, y: 273}, {x: 400, y: 0}]};

const regions = [region1, region2, region3, region4];

//const pamDiff = new PamDiff({grayscale: 'luminosity', regions : regions});

const pamDiff = new PamDiff({difference: 6, percent: 1, regions: regions, mask: true});


pamDiff.on('diff', (data)=> {
    console.log('diff', data.trigger[0].name, data.trigger[0].percent);
    //console.log(data);
});

pipe2pam.pipe(pamDiff, {end: false});

const mp4frag = new Mp4Frag();

mp4frag.on('initialized', (data)=> {
    console.log('initialized', data);
});

mp4frag.on('segment', (segment)=> {
    console.log('segment1', segment.length);
});

mp4frag.on('error', (error)=> {
    console.log('error ', error);
});

//mp4frag.pipe(myPass);

//todo add callback for ffmpeg logging to stderr

const fr = new FR(
    {
        //path to ffmpeg, only needed if not in PATH
        path: ffmpegPath,
        //detecting no activity for n amount of seconds will cause ffmpeg to be killed
        killAfterStall: 10,
        //ffmpeg will automatically be re-spawned if exiting, delayed by n amount of seconds
        spawnAfterExit: 2,
        //number of time to re-spawn after exiting with no progress
        reSpawnLimit: 10,
        params: [
            //debugging ffmpeg
            '-loglevel', 'quiet', '-hwaccel', 'auto',/* '-fflags', '+genpts+igndts+ignidx',*/
            //input from rtsp cam
            '-rtsp_transport', 'tcp', '-i', 'rtsp://192.168.1.25:554/user=admin_password=pass_channel=1_stream=1.sdp',
            //output fragmented mp4 to pipe
            '-f', 'mp4',/* '-use_wallclock_as_timestamps', '1', '-reset_timestamps', '1', */'-an', '-c:v', 'copy', '-movflags', '+frag_keyframe+empty_moov', 'pipe:1',//+faststart+frag_keyframe+empty_moov+default_base_moof+omit_tfhd_offset
            //output pam image to pipe
            '-f', 'image2pipe', '-an', '-c:v', 'pam', '-pix_fmt', 'rgb24', '-vf', 'fps=2,scale=640:-1', 'pipe:4'
        ],
        //pipes should match the pipes used in params
        pipes: [{stdioIndex: 1, destination: mp4frag}, {stdioIndex: 4, destination: pipe2pam}],//todo allow array of stackable pipes to be passed
        exitCallback: ()=>{
            mp4frag.resetCache();
            pipe2pam.resetCache();
            pamDiff.resetCache();
            console.log('exit callback');
        },
        logCallback: (logs)=>{
            console.log('received logs', logs);
        }
    })
    .start();

fr.on('exit', (code, signal)=>{
    console.log('external exit listener', code, signal);
    mp4frag.resetCache();
    pipe2pam.resetCache();
    pamDiff.resetCache();
});

fr.start();

setTimeout(()=>{
    //fr.stop();
    //pamDiff.setDifference(2);
    //pamDiff.setPercent(3);
    //pamDiff.setRegions(regions);
    //pamDiff.resetCache();
}, 5000);
