// Ensure you are using the correct version of ffmpeg.wasm and core.
// This example uses 0.9.7 for ffmpeg.min.js and 0.8.5 for ffmpeg-core.js,
// which is a common combination that works well.
const { createFFmpeg, fetchFile } = FFmpeg;
const ffmpeg = createFFmpeg({
    log: true, // Enable logging to see FFmpeg output
    corePath: 'https://unpkg.com/@ffmpeg/core@0.8.5/dist/ffmpeg-core.js', // Specify core path from CDN
    // You can optionally add a MEMFS size limit, but often the browser's own limit is hit first.
    // mainScriptUrl: 'https://unpkg.com/@ffmpeg/core@0.8.5/dist/ffmpeg-core.js' // Alternative for corePath if needed
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

// Clear all logs and output, and revoke Blob URLs
const resetApp = () => {
    logsElement.textContent = '';
    outputVideo.src = ''; // Clear video source
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

    const inputVideoFileName = videoFile.name.replace(/ /g, '_'); // Replace spaces for FFmpeg safety
    const inputAudioFileName = audioFile.name.replace(/ /g, '_');
    const outputFileName = 'synced_output.mp4';

    try {
        // 1. Load FFmpeg if not already loaded
        logMessage('Loading FFmpeg (this might take a moment if not cached)...');
        if (!ffmpeg.isLoaded()) {
            ffmpeg.setLogger(({ type, message }) => {
                // You can filter messages here if you want less verbosity
                // if (type === 'fferr') {
                logMessage(message);
                // }
            });
            await ffmpeg.load();
            logMessage('FFmpeg loaded.');
        } else {
            logMessage('FFmpeg already loaded.');
        }

        // 2. Write files to FFmpeg's virtual file system
        logMessage(`Writing video file (${inputVideoFileName}) to virtual file system...`);
        ffmpeg.FS('writeFile', inputVideoFileName, await fetchFile(videoFile));
        logMessage(`Writing audio file (${inputAudioFileName}) to virtual file system...`);
        ffmpeg.FS('writeFile', inputAudioFileName, await fetchFile(audioFile));

        // 3. Get durations of video and audio
        logMessage('Analyzing video and audio durations...');
        let videoDuration = 0;
        let audioDuration = 0;

        const durationRegex = /Duration: (\d{2}):(\d{2}):(\d{2})\.(\d{2})/;
        const originalLogger = ffmpeg.setLogger; // Store original logger if we need to revert

        // Temporarily set a logger to capture duration information
        ffmpeg.setLogger(({ type, message }) => {
            if (type === 'fferr' || type === 'log') { // FFmpeg logs often go to stderr or stdout (log type)
                const matches = message.match(durationRegex);
                if (matches) {
                    const [_, h, m, s, ms] = matches;
                    const durationInSeconds = parseInt(h) * 3600 + parseInt(m) * 60 + parseInt(s) + parseFloat(`0.${ms}`);
                    
                    // Simple heuristic to assign duration: check if the file name is in the message
                    if (message.includes(inputVideoFileName)) {
                        videoDuration = durationInSeconds;
                    } else if (message.includes(inputAudioFileName)) {
                        audioDuration = durationInSeconds;
                    }
                }
            }
            logMessage(message); // Also log everything to the UI
        });

        // Run FFmpeg commands to get info for each file
        await ffmpeg.run('-i', inputVideoFileName);
        await ffmpeg.run('-i', inputAudioFileName);

        // Revert to original logger if needed, though for this app, keeping the duration logger is fine
        // ffmpeg.setLogger(originalLogger); // Restore original logging behavior

        if (videoDuration === 0 || audioDuration === 0) {
            throw new Error("Could not determine video or audio duration. Files might be corrupted or unsupported.");
        }

        logMessage(`Original Video Duration: ${videoDuration.toFixed(2)} seconds`);
        logMessage(`Audio Duration: ${audioDuration.toFixed(2)} seconds`);

        // 4. Calculate speed factor
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
        logMessage('Processing video and audio...');

        // **Memory Optimization 1: Use faster preset and higher CRF**
        // 'ultrafast' preset sacrifices file size for speed and lower memory.
        // CRF 28 is lower quality than 23 but results in smaller files and can be faster.
        // Consider adding `-vf scale=w=1280:h=720` or similar if resolution is a common issue.
        // For simplicity, I'm not adding scale by default, but it's a powerful tool.
        await ffmpeg.run(
            '-i', inputVideoFileName,
            '-i', inputAudioFileName,
            '-filter_complex', `[0:v]setpts=PTS/${speedFactor}[v]`,
            '-map', '[v]',
            '-map', '1:a',
            '-c:v', 'libx264',
            '-preset', 'veryfast', // Changed from medium to veryfast
            '-crf', '25',         // Changed from 23 to 25 (slightly lower quality, smaller file)
            '-c:a', 'aac',
            '-b:a', '128k',
            '-shortest',
            '-y', // Overwrite output file without asking
            outputFileName
        );

        logMessage('Processing complete!');

        // 6. Read the output file and display/offer for download
        logMessage('Reading output file from virtual file system...');
        const data = ffmpeg.FS('readFile', outputFileName);
        const blob = new Blob([data.buffer], { type: 'video/mp4' });

        // **Memory Optimization 2: Revoke previous blob URL before creating new one**
        if (currentVideoURL) {
            URL.revokeObjectURL(currentVideoURL);
        }
        currentVideoURL = URL.createObjectURL(blob);

        outputVideo.src = currentVideoURL;
        downloadLink.href = currentVideoURL;
        downloadLink.textContent = `Download Synced Video (${outputFileName})`;

        outputContainer.style.display = 'block';
        logMessage('Video ready for playback and download.');

    } catch (error) {
        logMessage(`ERROR: ${error.message}`);
        console.error("FFmpeg processing failed:", error);
        alert(`An error occurred during processing. Check logs for details: ${error.message}`);
    } finally {
        // **Memory Optimization 3: Aggressive cleanup of virtual files**
        // Ensure this happens even if there was an error during processing.
        if (ffmpeg.isLoaded()) { // Only try to unlink if FFmpeg is actually loaded
            try {
                // Unlink input files as soon as they're not needed (after being read into FS)
                // This is done implicitly when we finish the process, but good to be explicit
                // or if you have multiple steps.
                // For this single-step process, unlinking in finally is sufficient.
                ffmpeg.FS('unlink', inputVideoFileName);
                ffmpeg.FS('unlink', inputAudioFileName);
                // Unlink output file as well, it's now in the Blob
                ffmpeg.FS('unlink', outputFileName);
                logMessage('Cleaned up virtual file system.');
            } catch (e) {
                console.warn("Error cleaning up virtual files:", e);
                logMessage(`Warning: Could not fully clean up virtual files: ${e.message}`);
            }
        }
        processBtn.disabled = false;
        resetBtn.disabled = false;
        logMessage('--- Processing Finished ---');
    }
});

// Initial state
resetApp();
