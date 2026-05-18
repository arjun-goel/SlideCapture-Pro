import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { Innertube, UniversalCache } from 'youtubei.js';
import ffmpeg from "fluent-ffmpeg";
import ffmpegInstaller from "ffmpeg-static";
import { GoogleGenAI, Type } from "@google/genai";
import fs from "fs";
import { v4 as uuidv4 } from "uuid";
import PDFDocument from "pdfkit";
import { Readable } from "stream";

if (ffmpegInstaller) {
  ffmpeg.setFfmpegPath(ffmpegInstaller);
}

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
  httpOptions: {
    headers: {
      'User-Agent': 'aistudio-build',
    }
  }
});

function getVideoId(url: string) {
  const regex = /(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/;
  const match = url.match(regex);
  return match ? match[1] : null;
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // Initialize Innertube with a more resilient client type
  let yt = await Innertube.create({
    cache: new UniversalCache(false),
    generate_session_locally: true,
    location: 'US',
  });

  // Ensure temp directory exists
  const TEMP_DIR = path.join(process.cwd(), "temp_slides");
  if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR);
  }

  // --- API Routes ---

  app.post("/api/analyze", async (req, res) => {
    const { url, isHuman } = req.body;
    const videoId = getVideoId(url);
    const log = (msg: string) => {
      console.log(msg);
      try {
        fs.appendFileSync(path.join(process.cwd(), "debug.log"), `${msg}\n`);
      } catch (e) {}
    };

    if (isHuman) {
      log(`[VERIFIED] User confirmed they are human for this request.`);
    }

    if (!videoId) {
      log(`[ERROR] Invalid URL: ${url}`);
      return res.status(400).json({ error: "Invalid YouTube URL" });
    }

    const taskId = uuidv4();
    const taskDir = path.join(TEMP_DIR, taskId);
    fs.mkdirSync(taskDir);

    try {
      log(`[${taskId}] Starting analysis for ID: ${videoId}`);
      
      // 1. Get player info using low-level API to bypass UI parser errors
      log(`[${taskId}] Fetching player data via low-level API...`);
      
      let response: any;
      const clients = ['ANDROID', 'IOS', 'TV', 'WEB', 'MWEB', 'ANDROID_VR', 'ANDROID_TESTSUITE'] as const;
      let lastPlayerErr: any;

      for (const client of clients) {
        try {
          if (isHuman) {
            // Initial delay to mimic user "looking" at the page
            if (clients.indexOf(client) === 0) {
              await new Promise(r => setTimeout(r, 2000));
            } else {
              // Add extra jitter delay to mimic human behavior between retries
              const jitter = 1500 + Math.random() * 2500;
              await new Promise(r => setTimeout(r, jitter));
            }
          }

          log(`[${taskId}] Attempting player fetch with client: ${client}`);
          
          const rawResponse = await yt.actions.execute('player', {
            videoId,
            client: client,
            parse: false 
          });
          
          response = rawResponse.data;
          
          if (response?.playabilityStatus?.status === 'OK') {
            log(`[${taskId}] Player data fetched successfully with ${client}`);
            break;
          } else {
            const status = response?.playabilityStatus?.status;
            const reason = response?.playabilityStatus?.reason;
            log(`[${taskId}] ${client} reported issue: ${status} - ${reason}`);
            
            // If it's a bot detection error, record it and potentially keep trying
            if (reason?.includes('bot') || reason?.includes('Sign in') || reason?.includes('confirm')) {
              lastPlayerErr = new Error(`Bot verification required: ${reason}`);
              continue; 
            }

            // Skip "not supported" or "unplayable" client-specific errors
            if (status === 'UNPLAYABLE' || status === 'ERROR' || reason?.includes('no longer supported')) {
              continue;
            }

            lastPlayerErr = new Error(reason || `Status: ${status}`);
          }
        } catch (e: any) {
          log(`[${taskId}] Error using client ${client}: ${e.message}`);
          // Don't let 400/Invalid client errors stop the loop
          if (!e.message.includes('400') && !e.message.includes('Invalid') && !e.message.includes('supported')) {
            lastPlayerErr = e;
          }
        }
      }

      if (!response || response.playabilityStatus?.status !== 'OK') {
        const errorMsg = lastPlayerErr?.message || "Video is restricted or private";
        log(`[${taskId}] Player fetch failed across all clients. Final Error: ${errorMsg}`);
        throw new Error(errorMsg);
      }

      const videoDetails = response.videoDetails;
      const title = videoDetails?.title || "Lecture Video";
      log(`[${taskId}] Player data fetched: ${title}`);

      if (videoDetails?.isLive) {
        log(`[${taskId}] Error: Live streams are not supported.`);
        return res.status(400).json({ error: "Live streams are currently not supported. Please use a recorded video." });
      }

      const streamingData = response.streamingData;
      if (!streamingData || (!streamingData.formats && !streamingData.adaptiveFormats)) {
        throw new Error("No streaming formats found.");
      }

      // Find a suitable format for analysis (360p or lowest available)
      const formats = [...(streamingData.formats || []), ...(streamingData.adaptiveFormats || [])];
      // Prefer mp4 video only or combined for analysis
      const analysisFormat = formats.find(f => f.qualityLabel === '360p' && f.mimeType.includes('video/mp4')) 
                        || formats.find(f => f.mimeType.includes('video/mp4'))
                        || formats[0];

      if (!analysisFormat || !analysisFormat.url) {
        throw new Error("No suitable video URL found.");
      }

      log(`[${taskId}] Analysis format selected: ${analysisFormat.qualityLabel || 'default'}`);

      // 2. Extract frames every 10 seconds for analysis
      const analysisFramesDir = path.join(taskDir, "analysis_frames");
      fs.mkdirSync(analysisFramesDir);

      log(`[${taskId}] Extracting analysis frames...`);
      await new Promise((resolve, reject) => {
        ffmpeg(analysisFormat.url)
          .fps(1/10) 
          .size('426x240') 
          .output(path.join(analysisFramesDir, "frame_%04d.jpg"))
          .on("end", resolve)
          .on("error", (err) => {
             log(`[${taskId}] FFMPEG Analysis Error: ${err.message}`);
             reject(err);
          })
          .run();
      });

      const frameFiles = fs.readdirSync(analysisFramesDir).sort();
      log(`[${taskId}] Extracted ${frameFiles.length} frames.`);
      const framesData = frameFiles.map(file => ({
        timestamp: (file.match(/\\d+/)?.map(Number)[0] ?? 0) * 10,
        path: path.join(analysisFramesDir, file)
      }));

      if (framesData.length === 0) {
        throw new Error("No frames extracted. Video might be too short or inaccessible.");
      }

      // 3. AI Analysis with Gemini
      log(`[${taskId}] Sending ${framesData.length} frames to Gemini...`);
      
      const frameParts = framesData.map(f => ({
        inlineData: {
          mimeType: "image/jpeg",
          data: fs.readFileSync(f.path).toString("base64")
        }
      }));

      const model = "gemini-3-flash-preview";
      const prompt = `These are frames from a lecture video extracted every 10 seconds. 
      Analyze these frames to identify when a slide is fully visible and about to change. 
      Group similar frames that belong to the same slide and pick the single best timestamp (in seconds) for each unique slide.
      The "best" moment is when the slide content is most complete and the teacher is not covering important text.
      Return a JSON array of objects with 'timestamp' and 'label' (e.g. "Slide 1: Intro").`;

      const aiResponse = await ai.models.generateContent({
        model,
        contents: [{ parts: [...frameParts.slice(0, 50), { text: prompt }] }], // Limit frames to 50 for token safety
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                timestamp: { type: Type.INTEGER },
                label: { type: Type.STRING }
              },
              required: ["timestamp", "label"]
            }
          }
        }
      });

      log(`[${taskId}] Gemini analysis complete.`);
      const selectedSlides = JSON.parse(aiResponse.text);
      log(`[${taskId}] Gemini selected ${selectedSlides.length} slides.`);

      // 4. Capture high-quality frames for the final PDF
      const finalFramesDir = path.join(taskDir, "final_frames");
      fs.mkdirSync(finalFramesDir);

      log(`[${taskId}] Downloading high-quality stream...`);
      // Select best MP4 quality (720p or 1080p)
      const hqFormat = formats.find(f => (f.qualityLabel === '1080p' || f.qualityLabel === '720p') && f.mimeType.includes('video/mp4'))
                    || formats.find(f => f.qualityLabel && f.mimeType.includes('video/mp4'))
                    || analysisFormat;

      log(`[${taskId}] HQ format selected: ${hqFormat.qualityLabel || 'default'}`);

      // We need to save the stream locally first to allow seeking multiple times for screenshots
      const hqFilePath = path.join(taskDir, "video_hq.mp4");
      
      // Using axios or similar to download the URL to a file
      // Since analysisFormat.url is a direct link
      const axios = (await import('axios')).default;
      const hqResponse = await axios({
        method: 'get',
        url: hqFormat.url,
        responseType: 'stream'
      });

      const hqFileWriter = fs.createWriteStream(hqFilePath);
      hqResponse.data.pipe(hqFileWriter);
      
      await new Promise<void>(resolve => hqFileWriter.on("finish", () => resolve()));
      log(`[${taskId}] HQ stream saved to disk.`);

      log(`[${taskId}] Capturing screenshots...`);
      for (let i = 0; i < selectedSlides.length; i++) {
        const slide = selectedSlides[i];
        const timestamp = slide.timestamp;
        await new Promise((resolve, reject) => {
          ffmpeg(hqFilePath)
            .screenshots({
              timestamps: [timestamp],
              filename: `slide_${i}.png`,
              folder: finalFramesDir,
              size: '1280x720'
            })
            .on("end", resolve)
            .on("error", reject);
        });
      }
      log(`[${taskId}] Screenshots captured.`);

      // 5. Generate PDF
      log(`[${taskId}] Generating PDF...`);
      const pdfPath = path.join(taskDir, "slides.pdf");
      const doc = new PDFDocument({ autoFirstPage: false });
      const stream_out = fs.createWriteStream(pdfPath);
      doc.pipe(stream_out);

      for (let i = 0; i < selectedSlides.length; i++) {
        const framePath = path.join(finalFramesDir, `slide_${i}.png`);
        if (fs.existsSync(framePath)) {
          doc.addPage({ size: [1280, 720] });
          doc.image(framePath, 0, 0, { width: 1280, height: 720 });
          doc.fontSize(24).fillColor('white').text(selectedSlides[i].label, 40, 40);
        }
      }
      doc.end();

      await new Promise<void>(resolve => stream_out.on("finish", () => resolve()));
      log(`[${taskId}] PDF generated.`);

      // Clean up heavy mp4
      if (fs.existsSync(hqFilePath)) fs.unlinkSync(hqFilePath);

      res.json({
        taskId,
        title,
        slideCount: selectedSlides.length,
        downloadUrl: `/api/download/${taskId}`
      });

    } catch (error: any) {
      log(`[${taskId}] Final Catch Error: ${error.message}`);
      const msg = error.message || "";
      const isBot = msg.includes("not a bot") || msg.includes("bot");
      const isLogin = msg.includes("login") || msg.includes("Sign in") || msg.includes("Sign-in");
      
      let userError = `Error: ${msg}`;
      if (isBot) userError = "YouTube bot detection triggered. Please ensure you checked 'I confirm I am not a bot' and try again. This helps the system use more robust fetch methods.";
      if (isLogin) userError = "This video is restricted (age-restricted or private) and requires login. Private or restricted content is not supported.";
      
      res.status(500).json({ error: userError });
    }
  });

  app.get("/api/download/:taskId", (req, res) => {
    const { taskId } = req.params;
    const pdfPath = path.join(TEMP_DIR, taskId, "slides.pdf");
    if (fs.existsSync(pdfPath)) {
      res.download(pdfPath, "lecture_slides.pdf");
    } else {
      res.status(404).send("File not found");
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
