// Ensure you are using the correct version of ffmpeg.wasm and core.
// This example uses 0.9.7 for ffmpeg.min.js and 0.8.5 for ffmpeg-core.js,
// which is a common combination that works well.
const { createFFmpeg, fetchFile } = FFmpeg;
const ffmpeg = createFFmpeg({
    log: true, // Enable logging to see FFmpeg output
    corePath: 'https://unpkg.com/@ffmpeg/core@0.8.5/dist/ffmpeg-core.js' // Specify core path from CDN
});

// Get DOM elements
const videoInput = document.getElementById('videoInput');
const audioInput = document.getElementById('audioInput');
const processBtn = document.getElementById('processBtn');
const resetBtn = document.getElementById('resetBtn');
const logsElement = document.getElementById('logs');
const outputVideo = document.getElementById('outputVideo');
const downloadLink = document.getElementById('downloadLink');
const outputContainer = document.getElementById('output-container');

let videoFile = null;
let audioFile = null;
let currentVideoURL = null; // To keep track of the created blob URL

// Function to append messages to the logs area
const logMessage = (msg) => {
    logsElement.textContent += msg + '\n';
    logsElement.scrollTop = logsElement.scrollHeight; // Auto-scroll to bottom
};

// Clear all logs and output
const resetApp = () => {
    logsElement.textContent = '';
    outputVideo.src = '';
    outputVideo.style.display = 'none';
    downloadLink.href = '#';
    downloadLink.style.display = 'none';
    outputContainer.style.display = 'none';
    videoInput.value = '';
    audioInput.value = '';
    videoFile = null;
    audioFile = null;
    processBtn.disabled = true;
    if (currentVideoURL) {
        URL.revokeObjectURL(currentVideoURL); // Clean up previous blob URL
        currentVideoURL = null;
    }
    logMessage('Application reset. Ready for new files.');
};

// Check if both files are selected to enable the process button
const checkFiles = () => {
    processBtn.disabled = !(videoFile && audioFile);
};

// Event listeners for file inputs
videoInput.addEventListener('change', (e) => {
    videoFile = e.target.files[0];
    logMessage(`Video file selected: ${videoFile ? videoFile.name : 'None'}`);
    checkFiles();
});

audioInput.addEventListener('change', (e) => {
    audioFile = e.target.files[0];
    logMessage(`Audio file selected: ${audioFile ? audioFile.name : 'None'}`);
    checkFiles();
});

// Reset button handler
resetBtn.addEventListener('click', resetApp);

// Main processing logic
processBtn.addEventListener('click', async () => {
    if (!videoFile || !audioFile) {
        alert('Please select both a video and an audio file.');
        return;
    }

    // Disable buttons during processing
    processBtn.disabled = true;
    resetBtn.disabled = true;
    logMessage('--- Starting Processing ---');
    logsElement.textContent = ''; // Clear previous logs for a fresh start

    try {
        // 1. Load FFmpeg if not already loaded
        logMessage('Loading FFmpeg (this might take a moment if not cached)...');
        if (!ffmpeg.isLoaded()) {
            ffmpeg.setLogger(({ type, message }) => {
                // You can filter messages here if you want less verbosity
                // if (type === 'fferr') { // FFmpeg logs often go to stderr
                logMessage(message);
                // }
            });
            await ffmpeg.load();
            logMessage('FFmpeg loaded.');
        } else {
            logMessage('FFmpeg already loaded.');
        }

        // 2. Write files to FFmpeg's virtual file system
        logMessage(`Writing video file (${videoFile.name}) to virtual file system...`);
        ffmpeg.FS('writeFile', videoFile.name, await fetchFile(videoFile));
        logMessage(`Writing audio file (${audioFile.name}) to virtual file system...`);
        ffmpeg.FS('writeFile', audioFile.name, await fetchFile(audioFile));

        // 3. Get durations of video and audio
        logMessage('Analyzing video and audio durations...');
        let videoDuration = 0;
        let audioDuration = 0;

        // Regex to parse duration from FFmpeg output (e.g., "Duration: 00:00:10.50")
        const durationRegex = /Duration: (\d{2}):(\d{2}):(\d{2})\.(\d{2})/;

        // Custom logger for duration parsing
        const durationLogger = ({ type, message }) => {
            if (type === 'fferr') { // FFmpeg often logs info to stderr
                const matches = message.match(durationRegex);
                if (matches) {
                    const [_, h, m, s, ms] = matches;
                    const durationInSeconds = parseInt(h) * 3600 + parseInt(m) * 60 + parseInt(s) + parseFloat(`0.${ms}`); // Use parseFloat for ms
                    
                    // A simple heuristic to assign duration to the correct file
                    // This relies on FFmpeg outputting the input file name before its duration
                    if (message.includes(videoFile.name)) {
                        videoDuration = durationInSeconds;
                    } else if (message.includes(audioFile.name)) {
                        audioDuration = durationInSeconds;
                    }
                }
            }
            logMessage(message); // Also log everything to the UI
        };
        ffmpeg.setLogger(durationLogger); // Temporarily set logger for duration parsing

        // Run FFmpeg commands to get info (this will output duration to logs)
        await ffmpeg.run('-i', videoFile.name);
        await ffmpeg.run('-i', audioFile.name);

        // Remove the specific duration logger and revert to basic logging if desired
        // (For simplicity, we keep the durationLogger active throughout)
        // ffmpeg.setLogger(({ message }) => logMessage(message)); // Revert if needed

        if (videoDuration === 0 || audioDuration === 0) {
            throw new Error("Could not determine video or audio duration. Files might be corrupted or unsupported.");
        }

        logMessage(`Original Video Duration: ${videoDuration.toFixed(2)} seconds`);
        logMessage(`Audio Duration: ${audioDuration.toFixed(2)} seconds`);

        // 4. Calculate speed factor
        // The goal is: new_video_duration = audio_duration
        // FFmpeg's setpts filter: new_PTS = old_PTS / speed_factor
        // So, original_video_duration / speed_factor = audio_duration
        // Rearranging: speed_factor = original_video_duration / audio_duration
        const speedFactor = videoDuration / audioDuration;

        logMessage(`Calculated speed factor for video: ${speedFactor.toFixed(4)}`);
        if (speedFactor > 1) {
            logMessage("Video will be sped up to match audio duration.");
        } else if (speedFactor < 1) {
            logMessage("Video will be slowed down to match audio duration.");
        } else {
            logMessage("Video and audio durations already match closely (no speed change needed).");
        }

        // 5. Run FFmpeg command to adjust video speed and merge with audio
        const outputFileName = 'synced_output.mp4';
        logMessage('Processing video and audio...');

        // FFmpeg command explanation:
        // -i ${videoFile.name} : Input video file
        // -i ${audioFile.name} : Input audio file
        // -filter_complex "[0:v]setpts=PTS/${speedFactor}[v]" :
        //    [0:v] refers to the video stream of the first input (video).
        //    setpts=PTS/${speedFactor} modifies the presentation timestamp (PTS) of each frame.
        //    If speedFactor > 1, PTS becomes smaller, so frames are shown faster (sped up).
        //    If speedFactor < 1, PTS becomes larger, so frames are shown slower (slowed down).
        //    [v] names this processed video stream.
        // -map "[v]" : Use the processed video stream.
        // -map 1:a : Use the audio stream from the second input (audio).
        // -c:v libx264 -preset medium -crf 23 : Video encoding settings (H.264, medium quality).
        //    'medium' preset is a good balance for browser-side. 'fast' or 'superfast' can be quicker.
        //    CRF (Constant Rate Factor) 23 is a good default quality. Lower means higher quality/larger file.
        // -c:a aac -b:a 128k : Audio encoding settings (AAC codec, 128kbps bitrate).
        // -shortest : Ensures the output duration is the length of the shortest stream.
        //             Since we've re-timed the video to match audio duration, this effectively trims to audio duration.
        await ffmpeg.run(
            '-i', videoFile.name,
            '-i', audioFile.name,
            '-filter_complex', `[0:v]setpts=PTS/${speedFactor}[v]`,
            '-map', '[v]',
            '-map', '1:a',
            '-c:v', 'libx264',
            '-preset', 'medium', // Balance between speed and file size
            '-crf', '23',        // Good quality
            '-c:a', 'aac',
            '-b:a', '128k',      // Standard audio quality
            '-shortest',
            outputFileName
        );

        logMessage('Processing complete!');

        // 6. Read the output file and display/offer for download
        logMessage('Reading output file from virtual file system...');
        const data = ffmpeg.FS('readFile', outputFileName);
        const blob = new Blob([data.buffer], { type: 'video/mp4' });
        currentVideoURL = URL.createObjectURL(blob); // Store for cleanup

        outputVideo.src = currentVideoURL;
        downloadLink.href = currentVideoURL;
        downloadLink.textContent = `Download Synced Video (${outputFileName})`; // Show filename

        outputContainer.style.display = 'block'; // Show the output section
        logMessage('Video ready for playback and download.');

    } catch (error) {
        logMessage(`ERROR: ${error.message}`);
        console.error("FFmpeg processing failed:", error);
        alert(`An error occurred during processing. Check logs for details: ${error.message}`);
    } finally {
        // Clean up files from virtual file system
        try {
            ffmpeg.FS('unlink', videoFile.name);
            ffmpeg.FS('unlink', audioFile.name);
            // Attempt to unlink output file, ignore if it wasn't created due to error
            try { ffmpeg.FS('unlink', 'synced_output.mp4'); } catch (e) {}
        } catch (e) {
            console.warn("Error cleaning up virtual files:", e);
        }
        processBtn.disabled = false;
        resetBtn.disabled = false;
        logMessage('--- Processing Finished ---');
    }
});

// Initial state
resetApp();
