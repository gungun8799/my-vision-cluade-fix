// ===== server.js (Backend) =====
import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import cors from 'cors';
import admin from 'firebase-admin';
import { ImageAnnotatorClient } from '@google-cloud/vision';
import { GoogleGenerativeAI } from '@google/generative-ai';
import puppeteer from 'puppeteer';
import xlsx from 'xlsx';
import { v4 as uuidv4 } from 'uuid';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import archiver from 'archiver';  // at the top with your other imports
import { promisify } from 'util';
import fsPromises from 'fs/promises';



import dotenv from 'dotenv';
dotenv.config({
  path: `.env.${process.env.NODE_ENV || 'development'}`
});

const PUPPETEER_SERVICE_URL = process.env.PUPPETEER_SERVICE_URL;
const FOLDER_PATH = path.join(process.cwd(), 'contracts');
const isProd = process.env.NODE_ENV === 'production';
// Support __dirname in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// ✅ Store Puppeteer sessions for different systems
const browserSessions = new Map();
const BASE_DIR   = process.cwd();
// Env and Express setup
const app = express();
const upload = multer({ dest: 'tmp_uploads/' });
// read comma-separated list of allowed origins from env
const isDev = process.env.NODE_ENV === 'development'
const allowedOrigins = isDev
  ? ['http://localhost:3000']
  : (process.env.FRONTEND_URLS || '')
      .split(',')
      .map(u => u.trim())
      .filter(Boolean)

console.log('⚙️  CORS allowed origins:', allowedOrigins)
async function callGeminiREST(prompt) {
  const url = 'https://generativelanguage.googleapis.com/v1beta2/models/gemini-1.5-flash:generateText';
    const body = {
    prompt: { text: prompt },
    temperature: 0.2
  };
  const res = await axios.post(url, body, {
    headers: { 'X-Goog-Api-Key': process.env.GEMINI_API_KEY }
  });
  return res.data.candidates[0].output;
}

app.use(cors({
  origin: (origin, cb) => {
    // allow no-origin (e.g. mobile apps / curl) or any of your listed domains
    if (!origin || allowedOrigins.includes(origin)) {
      return cb(null, true)
    }
    cb(new Error(`CORS policy: origin ${origin} not allowed`))
  },
  methods: ['GET','POST','PUT','DELETE','OPTIONS'],
  credentials: true,
  optionsSuccessStatus: 200     // ensure older browsers get a 200
}))
console.log('→ SIMPLICITY_USER=', process.env.SIMPLICITY_USER);
console.log('→ SIMPLICITY_PASS=', process.env.SIMPLICITY_PASS && '*****');
// 2) Add this line *immediately* after your `app.use(cors(...))`:

app.use(express.json());
app.use('/prompts', express.static(path.join(__dirname, 'prompts')));

// ——— FIREBASE INIT ———
let firebaseCred;
if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
  try {
    firebaseCred = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  } catch (e) {
    console.warn('❌ Invalid FIREBASE_SERVICE_ACCOUNT_JSON, falling back to GOOGLE_APPLICATION_CREDENTIALS:', e.message);
  }
}

if (firebaseCred) {
  admin.initializeApp({
    credential: admin.credential.cert(firebaseCred),
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
  });
} else {
  // Fallback to service account file (GOOGLE_APPLICATION_CREDENTIALS) or ADC
  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
  });
}

const db = admin.firestore();
const bucket = admin.storage().bucket();

app.use(express.json());
app.use(
  '/prompts',
  express.static(path.join(__dirname, 'prompts'))
);


// List the files in a folder
app.get('/api/list-files', async (req, res) => {
  try {
    const folder = req.query.folder;
    if (!['contracts','processed'].includes(folder)) {
      return res.status(400).json({ error: 'Invalid folder' });
    }
    const dir = path.join(process.cwd(), folder);
    const files = await fsPromises.readdir(dir);
    // only PDFs
    const pdfs = files.filter(f => f.toLowerCase().endsWith('.pdf'));
    res.json({ files: pdfs });
  } catch (err) {
    console.error('list-files error', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/chrome-paths', (req, res) => {
  const candidates = [
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/usr/bin/headless-chromium'
  ];
  const found = candidates
    .filter(p => fs.existsSync(p))
    .map(p => {
      let version = 'unknown';
      try {
        version = execSync(`${p} --version`, { encoding: 'utf8' }).trim();
      } catch {}
      return { path: p, version };
    });
  res.json({ found, all: candidates });
});


// DELETE /api/delete-entry?path=<url-encoded-relative-path>
// DELETE an individual file or empty folder
app.delete('/api/delete-entry', async (req, res) => {
  try {
    const relPath = req.query.path;               // e.g. "contracts/xyz.pdf"
    if (!relPath) {
      return res.status(400).json({ message: 'path query parameter is required' });
    }

    // Build the absolute path and ensure it stays under BASE_DIR
    const abs = path.resolve(BASE_DIR, relPath);
    if (!abs.startsWith(path.resolve(BASE_DIR))) {
      return res.status(403).json({ message: 'Forbidden: outside of allowed directory' });
    }

    const stats = await fs.promises.stat(abs);

    if (stats.isDirectory()) {
      // Only delete if directory is empty
      const entries = await fs.promises.readdir(abs);
      if (entries.length > 0) {
        return res.status(400).json({ message: 'Directory not empty' });
      }
      await fs.promises.rmdir(abs);
      console.log('[DELETE] Directory removed:', abs);
    } else {
      // It's a file
      await fs.promises.unlink(abs);
      console.log('[DELETE] File removed:', abs);
    }

    return res.json({ success: true });
  } catch (err) {
    console.error('[DELETE ENTRY ERROR]', err);
    return res.status(500).json({ message: err.message });
  }
});


app.post('/api/upload-file', upload.array('files'), async (req, res) => {
  try {
    const targetDir = path.join(process.cwd(), req.query.path || '', '');
    // ensure directory exists
    await fsPromises.mkdir(targetDir, { recursive: true });

    // move each uploaded file into targetDir
    for (let file of req.files) {
      const dest = path.join(targetDir, file.originalname);
      await fsPromises.rename(file.path, dest);
    }
    res.json({ success: true });
  } catch (err) {
    console.error('[UPLOAD-FILE Error]', err);
    // clean up any temp files
    for (let file of req.files || []) {
      try { await fsPromises.unlink(file.path); } catch {}
    }
    res.status(500).json({ success: false, message: err.message });
  }
});


// Helper to list a directory
app.get('/api/list-directory', async (req, res) => {
  const base = process.cwd(); // or wherever your folders live
  const requested = req.query.path || '';
  const full = path.join(base, requested);
  try {
    const items = await fs.promises.readdir(full, { withFileTypes: true });
    const entries = items.map(dirent => ({
      name: dirent.name,
      isDirectory: dirent.isDirectory(),
    }));
    res.json({ entries });
  } catch (err) {
    res.status(500).json({ message: 'Unable to list directory', error: err.message });
  }
});

// Download a single file
app.get('/api/download-file', async (req, res) => {
  const base = process.cwd();
  const filePath = path.join(base, req.query.path);
  res.download(filePath);
});

// Zip & download a folder
app.get('/api/download-folder', async (req, res) => {
  const base = process.cwd();
  const folderPath = path.join(base, req.query.path || '');
  const archive = archiver('zip', { zlib: { level: 9 } });

  res.attachment(`${path.basename(folderPath)}.zip`);
  archive.pipe(res);

  archive.directory(folderPath, false);
  archive.finalize();
});



// Add this route for checking file metadata and saving to Firebase
app.post('/api/process-pdf-folder', async (req, res) => {
  const folderPath = path.join(__dirname, 'contracts');  // Replace with your folder path
  const files = fs.readdirSync(folderPath).filter(f => f.toLowerCase().endsWith('.pdf'));

  const fileData = [];

  for (const file of files) {
    // ── IMMEDIATELY skip any filename that isn’t digits + "_" + (LO|LR) + digits + "_" + digits ──
    const baseName = file.replace(/\.pdf$/i, '');
    const validPattern = /^\d+_(?:LO|LR)\d+_\d+$/;
    if (!validPattern.test(baseName)) {
      console.log(`[⏭️  Skipping invalid filename on server] ${file}`);
      continue;
    }
    
    const filePath = path.join(folderPath, file);
    
    // Get last modified timestamp of the file
    const stats = fs.statSync(filePath);
    const lastModifiedTime = stats.mtime;  // Last modified time

    // Assuming contract_number is the name of the file without extension
    const contractNumber = path.basename(file, '.pdf');

    // Save to Firebase (file_check collection)
    await db.collection('file_check').doc(contractNumber).set({
      contract_number: contractNumber,
      last_modified_time: lastModifiedTime,
      contract_status: 'pending',  // Initially set as 'pending'
    });

    fileData.push({
      contract_number: contractNumber,
      last_modified_time,
      contract_status: 'pending',
    });
  }

  console.log('[File Check] Processed file data:', fileData);

  res.json({ success: true, files: fileData });
});

app.post('/api/fetch-next-pdf-to-process', async (req, res) => {
  try {
    // Fetch files ordered by last_modified_time (ascending)
    const snapshot = await db.collection('file_check')
      .where('contract_status', '==', 'pending')  // Only get pending files
      .orderBy('last_modified_time', 'asc')  // Order by the last modified time
      .limit(1)  // Get the oldest file that hasn't been processed yet
      .get();

    if (snapshot.empty) {
      return res.status(200).json({ success: true, message: 'No files to process' });
    }

    const fileDoc = snapshot.docs[0];
    const fileData = fileDoc.data();

    // Update the status to 'in-progress'
    await fileDoc.ref.update({
      contract_status: 'in-progress',
    });

    console.log('[File Check] Next file to process:', fileData.contract_number);

    res.json({ success: true, fileData });
  } catch (err) {
    console.error('[File Check Error]', err);
    res.status(500).json({ success: false, message: 'Error fetching next file to process', error: err.message });
  }
});

app.post('/api/process-pdf', async (req, res) => {
  const { contractNumber, filePath } = req.body;
  let browser;

  try {
    // ─── Launch Puppeteer ────────────────────────────────────────────────
    try {
      const isProd = process.env.NODE_ENV === 'production';
      const launchOptions = {
        headless: isProd,
        dumpio: false,    // don’t pipe Chrome’s own logs
        args: isProd
          ? [
              '--no-sandbox',
              '--disable-setuid-sandbox',
              '--disable-dev-shm-usage',
              '--disable-gpu',
              '--disable-software-rasterizer',
              '--single-process',
              '--disable-dbus-for-chrome'
            ]
          : ['--start-fullscreen'],
        ...(isProd && process.env.PUPPETEER_EXECUTABLE_PATH
          ? { executablePath: process.env.PUPPETEER_EXECUTABLE_PATH }
          : {}
        )
      };

      browser = await puppeteer.launch(launchOptions);
      console.log('[✅ Puppeteer launched]');
    } catch (launchErr) {
      console.error('[❌ Puppeteer failed to launch]', launchErr);
      throw launchErr;
    }

    const page = await browser.newPage();

    // ─── Proxy page console / errors / network ────────────────────────────
    page.on('console', msg => console.log(`↪️ PAGE LOG: ${msg.text()}`));
    page.on('pageerror', err => console.error('↪️ PAGE ERROR:', err));
    page.on('response', resp => console.log(`↪️ RESPONSE ${resp.status()} → ${resp.url()}`));

    // ─── Navigate to extraction UI ────────────────────────────────────────
    try {
      await page.goto('http://localhost:5001/extract-pdf', { waitUntil: 'networkidle0' });
      console.log('[↪️ Navigated to /extract-pdf]');
    } catch (navErr) {
      await page.screenshot({ path: `process-pdf-nav-fail-${contractNumber}.png` });
      console.error('[❌ Navigation to extract-pdf failed]', navErr);
      throw navErr;
    }

    // ─── Upload the PDF ───────────────────────────────────────────────────
    try {
      const input = await page.$('input[type="file"]');
      await input.uploadFile(filePath);
      console.log(`[↪️ Uploaded file ${filePath}]`);
    } catch (uploadErr) {
      await page.screenshot({ path: `process-pdf-upload-fail-${contractNumber}.png` });
      console.error('[❌ File upload failed]', uploadErr);
      throw uploadErr;
    }

    // ─── Trigger extraction ───────────────────────────────────────────────
    try {
      const btn = await page.$('button#extract');
      await btn.click();
      console.log('[↪️ Clicked Extract button]');
    } catch (clickErr) {
      await page.screenshot({ path: `process-pdf-click-fail-${contractNumber}.png` });
      console.error('[❌ Clicking Extract button failed]', clickErr);
      throw clickErr;
    }

    // ─── Wait for completion ──────────────────────────────────────────────
    try {
      await page.waitForSelector('#extraction-status', { visible: true, timeout: 60000 });
      console.log(`[✅ Extraction finished for contract: ${contractNumber}]`);
    } catch (waitErr) {
      await page.screenshot({ path: `process-pdf-wait-fail-${contractNumber}.png` });
      console.error('[❌ Waiting for extraction status failed]', waitErr);
      throw waitErr;
    }

    // ─── Update Firebase status ───────────────────────────────────────────
    const fileDocRef = db.collection('file_check').doc(contractNumber);
    await fileDocRef.update({ contract_status: 'completed' });
    console.log(`[✅ Firebase status updated for ${contractNumber}]`);

    res.json({ success: true, message: `File processed: ${contractNumber}` });
  } catch (err) {
    console.error('[PDF Process Error]', err);
    res.status(500).json({ success: false, message: 'Error processing PDF', error: err.message });
  } finally {
    if (browser) {
      try {
        await browser.close();
        console.log('[✅ Puppeteer closed]');
      } catch {}
    }
  }
});

// Firebase Admin Init
/*
const serviceAccount = JSON.parse(
  fs.readFileSync(path.join(__dirname, './loi-checker-firebase-adminsdk-fbsvc-e5de01d327.json'), 'utf8')
);
*/
// NEW – picks up GOOGLE_APPLICATION_CREDENTIALS for you


// Vision + Gemini
const visionClient = new ImageAnnotatorClient();
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

app.post('/api/extract-text-only', upload.single('file'), async (req, res) => {
  console.log('Incoming request to /api/extract-text-only');

  const file = req.file;
  if (!file) {
    return res.status(400).json({ message: 'No file uploaded' });
  }

  const selectedPagesRaw = req.body.pages || 'all';
  const selectedPages = selectedPagesRaw.toLowerCase() === 'all'
    ? []
    : selectedPagesRaw.split(',').map(p => parseInt(p.trim(), 10)).filter(n => !isNaN(n));

  const ext = path.extname(file.originalname).toLowerCase();
  const localFilePath = path.join(__dirname, file.path);
  const gcsPath = `uploaded/${file.originalname}`;
  await bucket.upload(localFilePath, { destination: gcsPath });
  const gcsUri = `gs://${bucket.name}/${gcsPath}`;
  let combinedText = '';

  try {
    if (ext === '.pdf') {
      const outputPrefix = `vision-output/${path.parse(file.originalname).name}_${Date.now()}/`;

      const request = {
        inputConfig: {
          gcsSource: { uri: gcsUri },
          mimeType: 'application/pdf',
        },
        outputConfig: {
          gcsDestination: { uri: `gs://${bucket.name}/${outputPrefix}` },
          batchSize: 5,
        },
        features: [{ type: 'DOCUMENT_TEXT_DETECTION' }],
      };
      if (selectedPages.length > 0) request.pages = selectedPages;

      console.log('[🔁 OCR] Starting asyncBatchAnnotateFiles...');
      const [operation] = await visionClient.asyncBatchAnnotateFiles({ requests: [request] });
      await operation.promise();
      console.log('[✅ OCR] asyncBatchAnnotateFiles completed');

      const [outputFiles] = await bucket.getFiles({ prefix: outputPrefix });

      for (const f of outputFiles) {
        if (!f.name.endsWith('.json')) continue;
        const [jsonData] = await f.download();
        const parsed = JSON.parse(jsonData.toString());
        const responses = parsed.responses || [];
        responses.forEach((page, i) => {
          const text = page.fullTextAnnotation?.text || '';
          combinedText += `\n\nFile: ${file.originalname} — Page ${i + 1}\n${text}`;
        });
      }
    } else {
      const [result] = await visionClient.documentTextDetection(localFilePath);
      const text = result.fullTextAnnotation?.text || '';
      combinedText += `\n\nFile: ${file.originalname}\n${text}`;
    }

    console.log('[📤 OCR Text Ready]');
    res.json({ success: true, text: combinedText });
  } catch (err) {
    console.error('[❌ OCR Extraction Error]', err);
    res.status(500).json({ message: 'OCR extraction failed', error: err.message });
  } finally {
    fs.unlinkSync(localFilePath);
  }
});


// ===== OCR Handler =====
app.post('/api/extract-text', upload.array('files'), async (req, res) => {
  console.log('Incoming request to /api/extract-text');
  const files = req.files;
  const promptKey = req.body.promptKey || 'LOI_permanent_fixed_fields';
  const selectedPagesRaw = req.body.pages || 'all';
  const selectedPages = selectedPagesRaw.toLowerCase() === 'all'
    ? []
    : selectedPagesRaw.split(',').map(p => parseInt(p.trim(), 10)).filter(n => !isNaN(n));

  if (!files?.length) {
    console.error('[❌ No files uploaded]');
    return res.status(400).json({ message: 'No files uploaded' });
  }

  const promptFilePath = path.join(__dirname, 'prompts', `${promptKey}.txt`);
  if (!fs.existsSync(promptFilePath)) {
    return res.status(400).json({ message: `Prompt template '${promptKey}' not found.` });
  }
  const promptTemplate = fs.readFileSync(promptFilePath, 'utf8');

  let combinedText = '';

  for (const file of files) {
    const ext = path.extname(file.originalname).toLowerCase();
    const localFilePath = path.join(__dirname, file.path);
    const gcsPath = `uploaded/${file.originalname}`;
    await bucket.upload(localFilePath, { destination: gcsPath });
    const gcsUri = `gs://${bucket.name}/${gcsPath}`;

    if (ext === '.pdf') {
      const outputPrefix = `vision-output/${path.parse(file.originalname).name}_${Date.now()}/`;

      const request = {
        inputConfig: {
          gcsSource: { uri: gcsUri },
          mimeType: 'application/pdf',
        },
        outputConfig: {
          gcsDestination: { uri: `gs://${bucket.name}/${outputPrefix}` },
          batchSize: 5,
        },
        features: [{ type: 'DOCUMENT_TEXT_DETECTION' }],
      };
      if (selectedPages.length > 0) request.pages = selectedPages;

      console.log('[🔁 OCR] Starting asyncBatchAnnotateFiles...');
      const [operation] = await visionClient.asyncBatchAnnotateFiles({ requests: [request] });
      await operation.promise();
      console.log('[✅ OCR] asyncBatchAnnotateFiles completed');

      const [outputFiles] = await bucket.getFiles({ prefix: outputPrefix });
      let extracted = '';

      for (const f of outputFiles) {
        if (!f.name.endsWith('.json')) continue;
        const [jsonData] = await f.download();
        const parsed = JSON.parse(jsonData.toString());
        const responses = parsed.responses || [];
        responses.forEach((page, i) => {
          const text = page.fullTextAnnotation?.text || '';
          extracted += `\n\nFile: ${file.originalname} — Page ${i + 1}\n${text}`;
        });
      }

      combinedText += extracted;
    } else {
      const [result] = await visionClient.documentTextDetection(localFilePath);
      const text = result.fullTextAnnotation?.text || '';
      combinedText += `\n\nFile: ${file.originalname}\n${text}`;
    }

    console.log('[📥 Upload Check] Files received:', req.files?.length);
    fs.unlinkSync(localFilePath);
  }

  // === Gemini Processing ===
  const finalPrompt = `${promptTemplate}\n\nText:\n${combinedText}`;
  const geminiRes = await model.generateContent(finalPrompt);
  const geminiText = await geminiRes.response.text();

  // === Extract contract number ===
  let docId = 'unknown';
  try {
    const cleaned = geminiText.trim().replace(/^```json\s*/i, '').replace(/```$/, '').trim();
    const parsed = JSON.parse(cleaned);
    if (parsed["Contract Number"]) {
      docId = parsed["Contract Number"].trim().replace(/\//g, '_');
    }
  } catch (err) {
    console.warn('[Firestore Save] Failed to extract contract number:', err.message);
  }

  // === Save to Firebase ===
  await db.collection('vision_results').doc(docId).set({
    timestamp: new Date(),
    extracted_text: combinedText,
    gemini_response: geminiText,
    prompt_key: promptKey,
  });

  console.log(`[📤 Firebase] Document saved as ID: ${docId}`);
  res.json({ success: true, text: combinedText, geminiOutput: geminiText });
});

// right after your other routes, e.g. near /list-directory and /download-file
app.post(
  '/api/upload-file',
  upload.single('file'),
  async (req, res) => {
    try {
      const targetPath = req.query.path || '';      // e.g. "contracts" or "contracts/subfolder"
      const file = req.file;                         // from multer
      if (!file) {
        return res.status(400).json({ error: 'No file uploaded' });
      }

      // compute where to move it
      const destDir = path.join(__dirname, targetPath);
      if (!fs.existsSync(destDir)) {
        fs.mkdirSync(destDir, { recursive: true });
      }

      // move from multer's temp upload to your folder
      const finalPath = path.join(destDir, file.originalname);
      fs.renameSync(file.path, finalPath);

      res.json({ success: true, path: `${targetPath}/${file.originalname}` });
    } catch (err) {
      console.error('Upload error:', err);
      res.status(500).json({ error: err.message });
    }
  }
);

// --- LOGIN endpoint ---
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Missing email or password' });
  }

  try {
    // Query Firestore collection 'user_login' where field 'email' == submitted email
    const snapshot = await db
      .collection('user_login')
      .where('email', '==', email)
      .limit(1)
      .get();

    if (snapshot.empty) {
      // No user found with that email
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const userDoc = snapshot.docs[0];
    const data = userDoc.data();

    // Simple plaintext comparison (since your example stores password="123456")
    if (data.password !== password) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Successful login → return email & role
    return res.json({
      email: data.email,
      role: data.role,
    });
  } catch (err) {
    console.error('[LOGIN ERROR]', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/get-lead-statuses
app.get('/api/get-lead-statuses', async (req, res) => {
  try {
    const snapshot = await db.collection('compare_result').get();
    const statuses = {};
    snapshot.forEach(doc => {
      const data = doc.data();
      // contract_number in Firestore is stored without slashes
      statuses[data.contract_number] = data.lead_status || '';
    });
    return res.json({ success: true, statuses });
  } catch (err) {
    console.error('[GET Lead Statuses Error]', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});
// ===== Excel Sheet Upload - Get Sheet Names =====
app.post('/api/get-sheet-names', upload.single('file'), async (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ message: 'No file uploaded' });

    const filePath = path.join(__dirname, file.path);
    const workbook = xlsx.readFile(filePath);
    const sheetNames = workbook.SheetNames;
    const tempFileName = `${uuidv4()}_${file.originalname}`;
    const tempDest = path.join(__dirname, 'uploads', tempFileName);

    fs.renameSync(filePath, tempDest);
    res.json({ sheetNames, tempFileName });
  } catch (err) {
    console.error('Error getting sheet names:', err);
    res.status(500).json({ message: 'Failed to get sheet names', error: err.message });
  }
});

// ===== Excel Sheet Processor =====
app.post('/api/process-sheet', async (req, res) => {
  try {
    const { fileName, sheetName, promptKey = 'LOI_permanent_fixed_fields' } = req.body;
    const filePath = path.join(__dirname, 'uploads', fileName);

    const promptFilePath = path.join(__dirname, 'prompts', `${promptKey}.txt`);
    if (!fs.existsSync(promptFilePath)) {
      return res.status(400).json({ message: `Prompt template '${promptKey}' not found.` });
    }
    const promptTemplate = fs.readFileSync(promptFilePath, 'utf8');

    const workbook = xlsx.readFile(filePath);
    if (!workbook.Sheets[sheetName]) {
      return res.status(400).json({ message: `Sheet "${sheetName}" not found` });
    }

    const jsonData = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName]);
    const jsonString = JSON.stringify(jsonData, null, 2);

    const finalPrompt = `${promptTemplate}\n\nData:\n${jsonString}`;
    const geminiRes = await model.generateContent(finalPrompt);
    const geminiText = await geminiRes.response.text();

    // Attempt to extract Contract Number
    let contractId = 'unknown_excel_id';
    try {
      const match = geminiText.match(/"Contract Number"\s*:\s*"([^"]+)"/);
      if (match) contractId = match[1].replace(/\//g, '_');
      console.log('[📄 Excel Contract ID]', contractId);
    } catch (err) {
      console.warn('[⚠️ Could not extract contract number from Excel Gemini]', err.message);
    }

    await db.collection('excel_results').doc(contractId).set({
      timestamp: new Date(),
      raw_data: jsonString,
      gemini_response: geminiText,
      prompt_key: promptKey,
    });

    fs.unlinkSync(filePath);

    res.json({ success: true, table: jsonData, geminiOutput: geminiText });
  } catch (err) {
    console.error('Error in /api/process-sheet:', err);
    res.status(500).json({ message: 'Error processing sheet', error: err.message });
  }
});

// ===== Web Scraping =====
// ===== Web Scraping (Simplicity Internal Navigation) =====
// ... (existing imports & setup code remain unchanged)

app.post('/api/scrape-url', async (req, res) => {
  console.log('[Simplicity] Incoming request to /api/scrape-url');
  console.log('[Request Body]', req.body);

  // ─── DELEGATE TO REMOTE PUPPETEER SERVICE IF CONFIGURED ───────────────
  if (process.env.PUPPETEER_SERVICE_URL) {
    console.log('[STEP] delegating scrape-url to remote Puppeteer service]');
    try {
      const { data } = await axios.post(
        `${process.env.PUPPETEER_SERVICE_URL}/api/scrape-url`,
        req.body,
        { timeout: 600000 }
      );
      return res.status(data.success ? 200 : 502).json(data);
    } catch (err) {
      console.error(
        '[ERROR] remote scrape-url failed:',
        err.response?.status,
        err.response?.data || err.message
      );
      return res.status(502).json({
        message: 'Remote scrape-url service error',
        error: err.response?.data || err.message
      });
    }
  }

  try {
    const {
      systemType = 'simplicity',
      promptKey = 'LOI_permanent_fixed_fields',
      contractNumber,
      username: bodyUser,
      password: bodyPass
    } = req.body;

    if (!contractNumber) {
      console.error('[❌ No contract number provided]');
      return res.status(400).json({ message: 'Contract number is required' });
    }

    // 1) Source credentials from request body or environment
    const user = bodyUser || process.env.SIMPLICITY_USER;
    const pass = bodyPass || process.env.SIMPLICITY_PASS;
    if (!user || !pass) {
      console.error('[❌ Missing Simplicity credentials]');
      return res
        .status(400)
        .json({ message: 'Missing Simplicity username or password' });
    }

    let browser, page;

    // if we don’t yet have a Puppeteer session, log in now
    if (!browserSessions.has(systemType)) {
      console.log(`[🔐 Logging in to Simplicity as ${user}]`);
      try {
        // —— NEW LAUNCH LOGIC —— 
        const isProd = process.env.NODE_ENV === 'production';
        const launchOpts = {
          headless:  isProd,                           // prod: headless, local: headed
          dumpio:    false,
          args:      isProd
            ? [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--disable-software-rasterizer',
                '--single-process',
                '--disable-dbus-for-chrome'
              ]
            : ['--start-fullscreen'],
          ...(isProd && process.env.PUPPETEER_EXECUTABLE_PATH
            ? { executablePath: process.env.PUPPETEER_EXECUTABLE_PATH }
            : {}
          )
        };

        browser = await puppeteer.launch(launchOpts);
        page    = await browser.newPage();
        console.log('[✅ Puppeteer launched]');

        // navigate to Simplicity login
        await page.goto(process.env.SIMPLICITY_LOGIN_URL, { waitUntil: 'networkidle0' });

        // fill in credentials
        await page.waitForSelector('input[name="email"]', { timeout: 10000 });
        await page.type('input[name="email"]', user);
        await page.waitForSelector('input[name="password"]', { timeout: 10000 });
        await page.type('input[name="password"]', pass);

        // submit form & await navigation
        await Promise.all([
          page.click('button[type="submit"]'),
          page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 20000 })
        ]);

        // confirm login by checking for a dashboard-specific element
        const postLoginSelector = 'selector-you-see-after-login';
        await page.waitForSelector(postLoginSelector, { timeout: 10000 });

        // store session for reuse
        // grab the stored session
        const { browser, page } = browserSessions.get(systemType);
        console.log(`[✅ Logged in to Simplicity as ${user}]`);
      } catch (err) {
        console.error('[❌ Simplicity login failed]', err.message || err);
        return res.status(401).json({
          message: 'Login to Simplicity failed',
          error: err.message
        });
      }
    }

    // now we have page & browser
    ({ browser, page } = browserSessions.get(systemType));
    const isLeaseOffer = contractNumber.includes('LO');
    const submenuText = isLeaseOffer ? 'Lease Offer' : 'Lease Renewal';

    console.log(`[Simplicity] Navigating Lease > ${submenuText}...`);
    await page.waitForSelector(
      '#menu_MenuLiteralDiv > ul > li:nth-child(10) > a',
      { timeout: 10000 }
    );
    await page.click('#menu_MenuLiteralDiv > ul > li:nth-child(10) > a');
    await page.mouse.click(5, 5);
    await new Promise(r => setTimeout(r, 500));

    await page.evaluate(() => {
      const leaseMenu = [...document.querySelectorAll('a')].find(
        el => el.textContent.trim() === 'Lease'
      );
      leaseMenu?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    await new Promise(r => setTimeout(r, 2000));

    const submenuClicked = await page.evaluate(text => {
      const links = [...document.querySelectorAll('a')];
      const target = links.find(el => el.textContent.trim() === text);
      if (target) { target.click(); return true; }
      return false;
    }, submenuText);

    if (!submenuClicked) {
      console.error(`❌ Could not click ${submenuText}`);
      throw new Error(`Could not click ${submenuText}`);
    }
    console.log(`✅ ${submenuText} clicked`);
    await new Promise(r => setTimeout(r, 10000));

    console.log('[Simplicity] Searching for contract number:', contractNumber);
    await page.waitForSelector('iframe[name="frameBottom"]', { timeout: 70000 });
    const iframeHandle = await page.$('iframe[name="frameBottom"]');
    const frame = await iframeHandle.contentFrame();
    if (!frame) throw new Error('Could not access iframe content');

    await frame.waitForSelector('#panel_SimpleSearch_c1', {
      visible: true,
      timeout: 70000
    });
    console.log('[Simplicity] Typing and submitting contract number...');
    await frame.evaluate(cn => {
      const inp = document.querySelector('#panel_SimpleSearch_c1');
      inp.value = cn;
      inp.focus();
    }, contractNumber);

    console.log('[Simplicity] Clicking search button...');
    await frame.waitForSelector('a#panel_buttonSearch_bt', {
      visible: true,
      timeout: 10000
    });
    await frame.evaluate(() => {
      document.querySelector('a#panel_buttonSearch_bt')?.click();
    });
    await new Promise(r => setTimeout(r, 60000));

    console.log('[Simplicity] Clicking view icon...');
    const viewButton = await frame.$('input[src*="view-black-16.png"]');
    if (!viewButton) {
      console.error('❌ View icon not found');
      throw new Error('View icon not found');
    }
    await viewButton.click();

    const popupUrlMatch = isLeaseOffer
      ? 'leaseoffer/edit.aspx'
      : 'leaserenewal/edit.aspx';

    // Close any old popups
    for (const p of await browser.pages()) {
      const url = p.url();
      if (
        (url.includes('leaseoffer/edit.aspx') ||
         url.includes('leaserenewal/edit.aspx')) &&
        p !== page
      ) {
        await p.close();
      }
    }

    // Wait for the new popup
    let popup;
    for (let i = 0; i < 15; i++) {
      const pages = await browser.pages();
      popup = pages.find(p => p.url().includes(popupUrlMatch) && p !== page);
      if (popup) break;
      await new Promise(r => setTimeout(r, 2000));
    }
    if (!popup) {
      console.error('❌ Popup window not found for:', popupUrlMatch);
      throw new Error('Popup window not found');
    }

    await popup.bringToFront();
    await popup.waitForFunction(
      () => document.body && document.body.innerText.trim().length > 0,
      { timeout: 60000 }
    );
    await popup
      .waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 })
      .catch(() => {});

    console.log('[Simplicity] Final popup URL:', popup.url());

    console.log('[Simplicity] Expanding collapsible sections…');
    const collapsibleIds = [
      '#panelMonthlyCharge_label',
      '#panelOtherMonthlyCharge_label',
      '#panelGTO_label',
      '#LeaseMeterTypessArea_label',
      '#panelSecurityDeposit_label',
      '#panelOneTimeCharge_label'
    ];
    await new Promise(r => setTimeout(r, 20000));
    for (const sel of collapsibleIds) {
      try {
        const isCollapsed = await popup.$eval(
          sel,
          el => el.classList.contains('collapsible-panel-collapsed')
        );
        if (isCollapsed) {
          await popup.click(sel);
          console.log(`✅ Expanded: ${sel}`);
          await new Promise(r => setTimeout(r, 7000));
        }
      } catch (e) {
        console.warn(`⚠️ Could not expand ${sel}:`, e.message);
      }
    }

    const scrapedText = await popup.evaluate(() => document.body.innerText);
    console.log('[Simplicity] Scraped content length:', scrapedText.length);
    console.log('[Simplicity scrape-url complete]');

    // …the rest of your Gemini & Firestore logic remains exactly as before…
    // (saving to compare_result, etc.)
    // …after expanding all panels…


    // ─── Send scrapedText through Gemini ────────────────────────────────
    console.log('[Simplicity] Sending scraped content to Gemini model...');
    const promptFilePath = path.join(__dirname, 'prompts', `${promptKey}.txt`);
    const promptTemplate = fs.readFileSync(promptFilePath, 'utf8');
    const finalPrompt    = `${promptTemplate}\n\nContent:\n${scrapedText}`;
    const geminiRes      = await model.generateContent(finalPrompt);
    const geminiText     = await geminiRes.response.text();
    console.log('[Simplicity] Gemini output received');

    // ─── Extract leaseType & tenantType ────────────────────────────────
    let leaseType = '';
    let tenantType = '';
    try {
      const ltMatch = geminiText.match(/"Lease Type"\s*:\s*"([^"]+)"/);
      if (ltMatch) leaseType = ltMatch[1];
      const ttMatch = geminiText.match(/"Tenant Type"\s*:\s*"([^"]+)"/);
      if (ttMatch) tenantType = ttMatch[1];
      console.log('[📄 Scrape Lease Type]', leaseType, '[Tenant Type]', tenantType);
    } catch (e) {
      console.warn('[⚠️ Could not extract lease/tenant types]', e);
    }

    // ─── Persist to Firestore ───────────────────────────────────────────
    const docId = contractNumber.replace(/\//g, '_');
    await db.collection('compare_result').doc(docId).set({
      raw:           scrapedText,
      gemini_output: geminiText,
      lease_type:    leaseType,
      tenant_type:   tenantType,
      updated_at:    new Date()
    }, { merge: true });
    console.log('[🔥 compare_result updated with lease_type & tenant_type]');

    // ─── Final response ─────────────────────────────────────────────────
    return res.json({
      success:       true,
      raw:           scrapedText,
      geminiOutput:  geminiText,
      leaseType,
      tenantType
    });
  } catch (err) {
    console.error('[Simplicity scrape-url error]', err);
    res
      .status(500)
      .json({ message: 'Error during Simplicity navigation', error: err.message });
  }
});



app.post('/api/open-popup-tab', async (req, res) => {
  const { systemType = 'simplicity', contractNumber } = req.body;
  console.log('[🗭 Request] /api/open-popup-tab', { systemType, contractNumber });

  if (!contractNumber) return res.status(400).json({ message: 'Contract number required.' });

  try {
    let browser, page;

    // --- LOGIN STEP (two-step) ---
    if (!browserSessions.has(systemType)) {
      console.log('[🔑 Not logged in — triggering two-step login]');
    
      const isProd = process.env.NODE_ENV === 'production';
      const launchOpts = {
        headless:  isProd,                     // production → headless; local → headed
        defaultViewport: null,
        args:      isProd
          ? [
              '--no-sandbox',
              '--disable-setuid-sandbox',
              '--disable-dev-shm-usage',
              '--disable-gpu',
              '--disable-software-rasterizer',
              '--single-process',
              '--disable-dbus-for-chrome'
            ]
          : ['--start-fullscreen'],
        ...(isProd && process.env.PUPPETEER_EXECUTABLE_PATH
          ? { executablePath: process.env.PUPPETEER_EXECUTABLE_PATH }
          : {}
        )
      };
    
      browser = await puppeteer.launch(launchOpts);
      page    = await browser.newPage();
    
      // 1) Load landing
      console.log('[Login] Navigating to apptop.aspx');
      await page.goto('https://mall-management.lotuss.com/Simplicity/apptop.aspx', {
        waitUntil: 'networkidle2',
      });

      // 2) Click “Click to go to the login page”
      console.log('[Login] Waiting for Go-to-login button');
      await page.waitForSelector('#lblToLoginPage', { timeout: 20000 });
      console.log('[Login] Clicking Go-to-login');
      await page.click('#lblToLoginPage');
      await new Promise(r => setTimeout(r, 5000));

      // 3) Username + Continue
      console.log('[Login] Waiting for username field');
      await page.waitForSelector('input#username', { timeout: 20000 });
      console.log('[Login] Typing username');
      await page.type('input#username', 'john.pattanakarn@lotuss.com', { delay: 50 });
      const cont1 = '#root > div > div > div.sc-dymIpo.izSiFn > div.withConditionalBorder.sc-bnXvFD.izlagV > div.sc-jzgbtB.bIuYUf > form > div > div:nth-child(3) > div > button';
      console.log('[Login] Waiting for Continue #1');
      await page.waitForSelector(cont1, { timeout: 20000 });
      console.log('[Login] Clicking Continue #1');
      await page.click(cont1);
      await new Promise(r => setTimeout(r, 5000));

      // 4) Password + Continue
      console.log('[Login] Waiting for password field');
      await page.waitForSelector('input#password', { timeout: 20000 });
      console.log('[Login] Typing password');
      await page.type('input#password', 'Gofresh@0425-21', { delay: 50 });
      const cont2 = '#root > div > div > div.sc-dymIpo.izSiFn > div.withConditionalBorder.sc-bnXvFD.izlagV > div.sc-jzgbtB.bIuYUf > form > div > div:nth-child(4) > div > button';
      console.log('[Login] Waiting for Continue #2');
      await page.waitForSelector(cont2, { timeout: 20000 });
      console.log('[Login] Clicking Continue #2');
      await page.click(cont2);

      // 5) Wait for post-login
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle2' })
      ]).catch(() => {});
      await new Promise(r => setTimeout(r, 5000));

      // 6) Verify
      const html = await page.content();
      if (html.includes('Invalid login')) {
        console.error('[Login] Invalid credentials');
        await browser.close();
        return res.status(401).json({ success: false, message: 'Invalid credentials.' });
      }

      browserSessions.set(systemType, { browser, page });
      console.log('[✅ Login successful]');
    } else {
      ({ browser, page } = browserSessions.get(systemType));
    }

    // --- NAVIGATION & POPUP (unchanged) ---
    console.log('[📂 Navigating to Lease tab]');
    await page.waitForSelector('#menu_MenuLiteralDiv > ul > li:nth-child(10) > a', { timeout: 10000 });
    await page.click('#menu_MenuLiteralDiv > ul > li:nth-child(10) > a');
    await new Promise(r => setTimeout(r, 500));

    await page.evaluate(() => {
      const el = [...document.querySelectorAll('a')].find(a => a.textContent.trim() === 'Lease');
      if (el) el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    await new Promise(r => setTimeout(r, 2000));

    const menuToClick = contractNumber.includes('LR') ? 'Lease Renewal' : 'Lease Offer';
    const clicked = await page.evaluate((menuText) => {
      const target = [...document.querySelectorAll('a')].find(a => a.textContent.trim() === menuText);
      if (target) { target.click(); return true; }
      return false;
    }, menuToClick);

    if (!clicked) throw new Error(`❌ Could not click ${menuToClick}`);
    console.log(`[📎 Clicked submenu: ${menuToClick}]`);
    await new Promise(r => setTimeout(r, menuToClick === 'Lease Renewal' ? 8000 : 5000));

    
    const iframeHandle = await page.waitForSelector('iframe[name="frameBottom"]', { timeout: 70000 });
    const frame = await iframeHandle.contentFrame();
    await frame.waitForSelector('#panel_SimpleSearch_c1', { visible: true });
    await frame.evaluate((cn) => {
      const input = document.querySelector('#panel_SimpleSearch_c1');
      input.value = cn; input.focus();
    }, contractNumber);

    await frame.waitForSelector('a#panel_buttonSearch_bt', { visible: true });
    await frame.evaluate(() => document.querySelector('a#panel_buttonSearch_bt')?.click());
    await new Promise(r => setTimeout(r, 10000));

    const viewBtn = await frame.$('input[src*="view-black-16.png"]');
    if (!viewBtn) throw new Error('❌ View icon not found');
    await viewBtn.click();

    console.log('[📝 Waiting for popup tab...]');
    let popup;
    for (let i = 0; i < 10; i++) {
      const pages = await browser.pages();
      popup = pages.find(p => p.url().includes('leaseoffer/edit.aspx') && p !== page);
      if (popup) break;
      await new Promise(r => setTimeout(r, 1000));
    }

    if (popup) {
      await popup.bringToFront();
      console.log('[✅ Popup tab opened]');
    } else {
      console.warn('[⚠️ Popup tab not detected]');
    }

    return res.json({ success: true, message: `Popup triggered for ${menuToClick}.` });

  } catch (err) {
    console.error('[❌ /api/open-popup-tab error]', err);
    return res.status(500).json({ message: err.message });
  }
});


// end of scrape logic
app.post('/api/scrape-login', async (req, res) => {
  const { systemType } = req.body;
  // if client didn’t send creds, fall back to env
  const username = req.body.username || process.env.SIMPLICITY_USER;
  const password = req.body.password || process.env.SIMPLICITY_PASS;

  // No‐op for “others”
  if (!systemType || systemType === 'others') {
    return res.status(200).json({ success: true, message: 'No login required for Others.' });
  }
  // guard missing
  if (!username || !password) {
    return res
      .status(400)
      .json({ success: false, message: 'Missing Simplicity credentials' });
  }

  try {
    let browser, page;

    // 👉 If you have a remote Puppeteer service, delegate the login there
    if (process.env.PUPPETEER_SERVICE_URL) {
      const { data } = await axios.post(
        `${process.env.PUPPETEER_SERVICE_URL}/api/scrape-login`,
        { systemType, username, password }
      );
      // mirror your existing response shape
      return res.status(data.success ? 200 : 401).json(data);
    }

    // ─── Otherwise reuse or launch a local Puppeteer session ─────────────────
    if (browserSessions.has(systemType)) {
      ({ browser, page } = browserSessions.get(systemType));
    } else {
      console.log(`[🔑 Launching new Puppeteer session for ${systemType}]`);

      const isProd = process.env.NODE_ENV === 'production';
      const launchOptions = {
        headless: isProd,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          ...(isProd
            ? [
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--disable-software-rasterizer',
                '--single-process',
                '--disable-dbus-for-chrome'
              ]
            : ['--start-fullscreen']
          )
        ],
        ...(isProd && process.env.PUPPETEER_EXECUTABLE_PATH
          ? { executablePath: process.env.PUPPETEER_EXECUTABLE_PATH }
          : {}
        )
      };

      browser = await puppeteer.launch(launchOptions);
      page    = await browser.newPage();

      // store for reuse
      browserSessions.set(systemType, { browser, page });

      // 3) Go to the Simplicity landing page
      await page.goto(
        'https://mall-management.lotuss.com/Simplicity/apptop.aspx',
        { waitUntil: 'networkidle2' }
      );

      // add this helper at the top of your file:
async function withRetries(fn, attempts = 5, delayMs = 2000) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      console.warn(`Attempt ${i}/${attempts} failed: ${err.message}`);
      if (i < attempts) await new Promise(r => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

// …later, in your /api/scrape-login endpoint, replace the original block with:

// 4) Click “Click to go to the login page” + wait for it to load
await withRetries(async () => {
  await page.waitForSelector('#lblToLoginPage', { visible: true, timeout: 20000 });
  await Promise.all([
    page.click('#lblToLoginPage'),
    page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 90000 }),
  ]);
});

// 5) Enter username and Continue
await withRetries(async () => {
  await page.waitForSelector('input#username', { visible: true, timeout: 20000 });
  await page.type('input#username', username, { delay: 50 });

  const continueSel1 =
    '#root > div > div > div.sc-dymIpo.izSiFn > div.withConditionalBorder.sc-bnXvFD.izlagV ' +
    '> div.sc-jzgbtB.bIuYUf > form > div > div:nth-child(3) > div > button';

  await page.waitForSelector(continueSel1, { visible: true, timeout: 20000 });
  await Promise.all([
    page.click(continueSel1),
    page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 90000 }),
  ]);
});

// 6) Enter password and Continue
await withRetries(async () => {
  await page.waitForSelector('input#password', { visible: true, timeout: 20000 });
  await page.type('input#password', password, { delay: 50 });

  const continueSel2 =
    '#root > div > div > div.sc-dymIpo.izSiFn > div.withConditionalBorder.sc-bnXvFD.izlagV ' +
    '> div.sc-jzgbtB.bIuYUf > form > div > div:nth-child(4) > div > button';

  await page.waitForSelector(continueSel2, { visible: true, timeout: 20000 });
  await Promise.all([
    page.click(continueSel2),
    page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 90000 }).catch(() => {}),
  ]);
});

      // small extra buffer
      await new Promise(r => setTimeout(r, 10000));

      // 7) Verify login succeeded
      const html = await page.content();
      if (html.includes('Invalid login')) {
        await browser.close();
        return res.status(401).json({ success: false, message: 'Invalid credentials' });
      }

      // 8) Store for reuse
      browserSessions.set(systemType, { browser, page });
    }

    console.log(`[LOGIN] Simplicity login successful for ${username}`);
    return res.json({ success: true });

  } catch (err) {
    console.error('[SCRAPE-LOGIN Error]', err);
    return res.status(500).json({
      success: false,
      message: 'Login failed',
      error: err.message
    });
  }
});


// ===== Get Available Prompt Templates (.txt files) =====
app.get('/api/prompts', (req, res) => {
  const promptsDir = path.join(__dirname, 'prompts'); // assume ./prompts holds .txt files
  fs.readdir(promptsDir, (err, files) => {
    if (err) {
      console.error('Failed to read prompt directory:', err);
      return res.status(500).json({ message: 'Failed to read prompt templates' });
    }
    const promptKeys = files.filter(file => file.endsWith('.txt')).map(f => f.replace('.txt', ''));
    res.json({ promptKeys });
  });
});

// === Endpoint: Fetch latest gemini_response for selected sources ===
app.post('/api/fetch-latest-json', async (req, res) => {
  const { sources } = req.body;
  const collectionMap = {
    pdf: 'vision_results',
    web: 'scrape_results',  // Ensure that `scrape_results` is being used for the 'web' source
    excel: 'excel_results',
  };

  try {
    const results = {};

    for (const src of sources) {
      const collectionName = collectionMap[src];
      if (!collectionName) continue;

      const snapshot = await db
        .collection(collectionName)
        .orderBy('timestamp', 'desc')
        .limit(1)
        .get();

      if (!snapshot.empty) {
        const doc = snapshot.docs[0].data();
        console.log(`[Firebase doc for ${src}]`, doc);  // Log the full doc to check the structure

        // Check if gemini_response exists
        let geminiResponse = doc.gemini_response || '';  // Default to an empty string if missing
        if (!geminiResponse) {
          console.warn(`[Firebase] No gemini_response found for source: ${src}`);
        }

        // Clean and trim the response
        let cleaned = geminiResponse.trim();
        cleaned = cleaned.replace(/^```json\s*/i, '').replace(/```$/, '').trim();
        results[src] = cleaned;
        console.log(`[Firebase Cleaned] ${src}: ${cleaned}`);
      } else {
        console.warn(`[Firebase] No document found for source: ${src}`);
        results[src] = null;
      }
    }

    res.json({ success: true, results });
  } catch (err) {
    console.error('Error fetching latest JSON:', err);
    res.status(500).json({ message: 'Failed to fetch JSON from Firebase', error: err.message });
  }
});

// === Existing Gemini Compare Endpoint ===
// === Existing Gemini Compare Endpoint ===
app.post('/api/gemini-compare', async (req, res) => {
  console.log('[👁️ HIT /api/gemini-compare]')
  const { formattedSources, promptKey = 'LOI_permanent_fixed_fields' } = req.body;

  // 🔍 Determine which compare prompt file to use based on contract type
  let comparePromptFile = 'LOI_permanent_fixed_fields_compare.txt';
  if (promptKey.includes('service_express')) {
    comparePromptFile = 'LOI_service_express_fields_compare.txt';
  }

  const promptPath = path.join(__dirname, 'prompts', comparePromptFile);

  if (!fs.existsSync(promptPath)) {
    return res.status(400).json({
      message: `Prompt comparison file not found: ${comparePromptFile}`,
    });
  }

  const promptTemplate = fs.readFileSync(promptPath, 'utf8');

  const sourcesString = Object.entries(formattedSources)
    .map(([key, json]) => `${key.toUpperCase()}: ${JSON.stringify(json, null, 2)}`)
    .join('\n\n');

  const finalPrompt = `${promptTemplate}\n\nSources:\n${sourcesString}`;

  try {
    const geminiRes = await model.generateContent(finalPrompt);
    const responseText = await geminiRes.response.text();
    res.json({ response: responseText });
  } catch (err) {
    res.status(500).json({ message: 'Gemini comparison failed', error: err.message });
  }
  console.log('[🧾 Final Gemini Compare Prompt]', finalPrompt);
});

// ===== Force Process Endpoint =====

const API_URL = process.env.API_URL || 'http://localhost:5001';
app.post('/api/force-process-contract', async (req, res) => {
  const { contractNumber, promptKey = 'LOI_permanent_fixed_fields' } = req.body;
  if (!contractNumber) {
    return res
      .status(400)
      .json({ success: false, message: 'Missing contractNumber in request body' });
  }

  const doProcess = async () => {
    // 1) Auto‐login to Simplicity so scrape‐URL calls will succeed
    const loginRes = await axios.post(`${API_URL}/api/scrape-login`, {
      systemType: 'simplicity',
      username:   'john.pattanakarn@lotuss.com',
      password:   'Gofresh@0425-21'
    });
    if (!loginRes.data.success) {
      throw new Error('Auto-login to Simplicity failed');
    }

    // 2) Run the exact same pipeline you use in your folder‐processor,
    //    but just for this one file.
    const filename = `${contractNumber}.pdf`;
    const ok = await processOneContract(filename, promptKey);
    if (!ok) {
      throw new Error(`Processing logic returned false for ${filename}`);
    }
  };

  try {
    try {
      await doProcess();
    } catch (err) {
      // if we timed out clicking the Lease menu, clear the session and retry once
      if (err.message.includes('Waiting for selector') && err.message.includes('li:nth-child(10) > a')) {
        console.warn('[WARN] Lease-menu timeout, clearing session and retrying...');
        browserSessions.delete('simplicity');
        await doProcess();
      } else {
        throw err;
      }
    }

    return res.json({
      success: true,
      message: `Forced processing and end–to–end pipeline complete for ${contractNumber}`
    });

  } catch (err) {
    console.error('[❌ Force Process Error]', err);
    return res.status(500).json({
      success: false,
      message: 'Force processing failed',
      error: err.message
    });
  }
});



app.post('/api/store-compare-result', async (req, res) => {
  const { contractNumber, compareResult } = req.body;
  if (!contractNumber) return res.status(400).json({ message: 'Missing contractNumber' });

  try {
    const docId = contractNumber.replace(/\//g, '_');
    await db.collection('vision_results').doc(docId).set({
      compare_result: compareResult
    }, { merge: true });

    res.json({ success: true, message: 'Comparison result saved' });
  } catch (err) {
    console.error('[Firestore Compare Save Error]', err);
    res.status(500).json({ message: 'Failed to save compare result', error: err.message });
  }
});

//Web validation
app.post('/api/web-validate', async (req, res) => {
  // ─── DELEGATE TO REMOTE PUPPETEER SERVICE IF CONFIGURED ───────────────
if (process.env.PUPPETEER_SERVICE_URL) {
  console.log('[STEP] delegating web-validate to remote Puppeteer service]');
  try {
    const { data } = await axios.post(
      `${process.env.PUPPETEER_SERVICE_URL}/api/web-validate`,
      req.body,
      { timeout: 600000 }
    );
    return res.status(data.success ? 200 : 502).json(data);
  } catch (err) {
    console.error(
      '[ERROR] remote web-validate failed:',
      err.response?.status,
      err.response?.data || err.message
    );
    return res.status(502).json({
      message: 'Remote web-validate service error',
      error: err.response?.data || err.message
    });
  }
}

  const { contractNumber, extractedData, promptKey = 'default' } = req.body;
  if (!contractNumber || !extractedData || typeof extractedData !== 'object') {
    console.error('[Web Validation] Missing or invalid input:', req.body);
    return res.status(400).json({ message: 'Missing contractNumber or invalid extractedData' });
  }

  try {
    // ─── 1) LOGIN / SESSION SETUP ─────────────────────────────────
    const systemType = 'simplicity';
    let browser, page;

    if (browserSessions.has(systemType)) {
      ({ browser, page } = browserSessions.get(systemType));
      console.log('[LOGIN] Reusing existing Simplicity session');
    } else {
      console.log('[LOGIN] No session—launching new Puppeteer browser');
    
      const isProd = process.env.NODE_ENV === 'production';
      const launchOptions = {
        headless: isProd,
        defaultViewport: null,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          ...(isProd
            ? [
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--disable-software-rasterizer',
                '--single-process',
                '--disable-dbus-for-chrome'
              ]
            : ['--start-fullscreen']
          )
        ],
        ...(isProd && process.env.PUPPETEER_EXECUTABLE_PATH
          ? { executablePath: process.env.PUPPETEER_EXECUTABLE_PATH }
          : {}
        )
      };
    
      browser = await puppeteer.launch(launchOptions);
      page    = await browser.newPage();
    
      browserSessions.set(systemType, { browser, page });
      await page.setViewport({ width: 1920, height: 1080 });

      console.log('[LOGIN] Navigating to landing page');
      await page.goto('https://mall-management.lotuss.com/Simplicity/apptop.aspx', {
        waitUntil: 'networkidle2'
      });

      console.log('[LOGIN] clicking “go to login”');
      await page.waitForSelector('#lblToLoginPage', { visible: true, timeout: 20000 });
      await Promise.all([
        page.click('#lblToLoginPage'),
        page.waitForNavigation({ waitUntil: 'networkidle2' }).catch(() => {})
      ]);

      console.log('[LOGIN] entering username');
      await page.waitForSelector('input#username', { visible: true, timeout: 20000 });
      await page.type('input#username', 'john.pattanakarn@lotuss.com', { delay: 50 });

      const continueSel1 =
        '#root > div > div > div.sc-dymIpo.izSiFn > div.withConditionalBorder.sc-bnXvFD.izlagV ' +
        '> div.sc-jzgbtB.bIuYUf > form > div > div:nth-child(3) > div > button';
      console.log('[LOGIN] clicking Continue after username');
      await page.waitForSelector(continueSel1, { visible: true, timeout: 20000 });
      await page.click(continueSel1);

      console.log('[LOGIN] entering password');
      await page.waitForSelector('input#password', { visible: true, timeout: 20000 });
      await page.type('input#password', 'Gofresh@0425-21', { delay: 50 });

      const continueSel2 =
        '#root > div > div > div.sc-dymIpo.izSiFn > div.withConditionalBorder.sc-bnXvFD.izlagV ' +
        '> div.sc-jzgbtB.bIuYUf > form > div > div:nth-child(4) > div > button';
      console.log('[LOGIN] clicking Continue after password');
      await Promise.all([
        page.click(continueSel2),
        page.waitForNavigation({ waitUntil: 'networkidle2' }).catch(() => {})
      ]);

      console.log('[LOGIN] waiting for UI to settle');
      await new Promise(r => setTimeout(r, 10000));

      const postLoginHtml = await page.content();
      if (postLoginHtml.includes('Invalid login')) {
        console.error('[LOGIN] invalid credentials');
        await browser.close();
        return res.status(401).json({ success: false, message: 'Invalid credentials' });
      }

      console.log('[LOGIN] success');
      browserSessions.set(systemType, { browser, page });
    }

      // ─── 2) GEMINI-BASED WEB VALIDATION ─────────────────────────────
  const promptFilePath = path.join(__dirname, 'prompts', 'LOI_Sim_validation.txt');
  if (!fs.existsSync(promptFilePath)) {
    console.error('[VALIDATION] prompt file missing');
    return res.status(400).json({ message: 'Validation prompt file not found.' });
  }
  const promptTemplate = fs.readFileSync(promptFilePath, 'utf8');
  const finalPrompt = `${promptTemplate}\n\nExtracted Data:\n${JSON.stringify(extractedData, null, 2)}`;

  console.log('[Web Validation] sending to Gemini');
  // ==== here is the swap: use model.generateContent exactly like scrape-url ====
  const gemRes = await model.generateContent(finalPrompt);
  let gemText = await gemRes.response.text();
  gemText = gemText.trim().replace(/^```json\s*/i, '').replace(/```$/, '');

  let parsedResult;
  try {
    parsedResult = JSON.parse(gemText);
    if (!Array.isArray(parsedResult)) {
      throw new Error('Expected an array from Gemini');
    }
  } catch (err) {
    console.error('[Web Validation] parse error', err);
    return res.status(500).json({ message: 'Failed to parse Gemini output', raw: gemText });
  }
  console.log('[Web Validation] parsed result:', parsedResult);

    // ─── extract workflow status from parsedResult ────────────────
    const wfItem = parsedResult.find(
      row => row.field && row.field.toLowerCase() === 'workflow status'
    );
    const workflowStatus = wfItem ? wfItem.value : null;
    console.log('[Web Validation] workflow_status =', workflowStatus);

    // ─── 3) OPTIONAL “Meter” SCRAPE + GEMINI CHECK ─────────────────
    let utilityRaw = null;
    let meterValidation = null;

    if (extractedData['Include Utility'] === 'Yes' && contractNumber.includes('LO')) {
      console.log('[Utility] Include Utility=Yes & LO… → scraping Meter…');

      try {
        // 3.1 scroll so the Utilities button is visible
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        console.log('[Utility] scrolled down');
        await new Promise(r => setTimeout(r, 2000));

        // 3.2 click Utilities top-menu
        const utilSel = '#menu_MenuLiteralDiv > ul > li:nth-child(22) > a > div.cssmenu-item-label';
        console.log('[Utility] clicking Utilities top-menu');
        await page.waitForSelector(utilSel, { visible: true, timeout: 20000 });
        await page.click(utilSel);

        // 3.3 hover to expand submenu
        console.log('[Utility] hovering Utilities submenu');
        await page.evaluate(() => {
          const li = document.querySelector('#menu_MenuLiteralDiv > ul > li:nth-child(22)');
          li?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        });
        await new Promise(r => setTimeout(r, 10000));

        // 3.4 click “Meter” submenu
        console.log('[Utility] clicking Meter submenu');
        const clickedMeter = await page.evaluate(() => {
          const menu = document.querySelector('#menu_MenuLiteralDiv > ul > li:nth-child(22) ul');
          if (!menu) return false;
          const a = Array.from(menu.querySelectorAll('a'))
            .find(x => x.textContent.trim() === 'Meter');
          if (a) { a.click(); return true; }
          return false;
        });
        if (!clickedMeter) throw new Error('Could not click Meter submenu');
        console.log('[Utility] Meter submenu clicked');

        // 3.5 wait & switch to bottom iframe
        await new Promise(r => setTimeout(r, 10000));
        const frameHandle = await page.waitForSelector('iframe[name="frameBottom"]', { timeout: 20000 });
        const frame = await frameHandle.contentFrame();
       
        await new Promise(r => setTimeout(r, 10000));
// ─── 3.6 Combined Unit ID + Building ID search ────────────────────
console.log('[Utility] preparing combined Unit ID + Building ID search');

// wait for the main search box
await frame.waitForSelector('#panel_SimpleSearch_c1', { visible: true, timeout: 20000 });

// pull the 4-digit Building ID from your parsedResult
const buildingRow = parsedResult.find(r => r.field === 'Building ID');
const buildingId = buildingRow?.value || '';
console.log('[Utility] fetched Building ID:', buildingId);

// build the combined search string
const unitId = extractedData['Unit ID'] || '';
const combinedSearch = buildingId
  ? `${unitId} ${buildingId}`
  : unitId;

console.log('[Utility] entering combined search:', combinedSearch);

// clear & type the combined string
await frame.click('#panel_SimpleSearch_c1', { clickCount: 3 });
await frame.type('#panel_SimpleSearch_c1', combinedSearch, { delay: 50 });

// click the initial Search button
console.log('[Utility] clicking Search');
await frame.evaluate(() => {
  const btn = document.querySelector('a#panel_buttonSearch_bt');
  btn?.click();
});
await new Promise(r => setTimeout(r, 15000));

// scrape immediately
utilityRaw = await frame.evaluate(() => document.body.innerText);
console.log('[Utility] scraped raw after combined search:', utilityRaw);


        // 3.8 run Gemini on that Meter page
        const meterPromptPath = path.join(__dirname, 'prompts', 'meter_check.txt');
        if (fs.existsSync(meterPromptPath)) {
          const meterTemplate = fs.readFileSync(meterPromptPath, 'utf8');
          const meterPrompt = `${meterTemplate}\n\nMeter page content:\n${utilityRaw}`;
          console.log('[Meter Validation] sending to Gemini');
          const mRes = await model.generateContent(meterPrompt);
          let mText = (await mRes.response.text()).trim();
          if (mText.startsWith('```json')) mText = mText.slice(7);
          if (mText.endsWith('```'))      mText = mText.slice(0, -3);

          try {
            meterValidation = JSON.parse(mText);
            console.log('[Meter Validation] parsed:', meterValidation);
          } catch (e) {
            console.error('[Meter Validation] parse failed', e);
          }
        } else {
          console.warn('[Meter Validation] prompt file missing, skipping');
        }
      } catch (err) {
        console.error('[Utility] scrape failed, continuing:', err);
      }
    }

    // ─── 4) SAVE TO FIRESTORE ─────────────────────────────────────
    const docId = contractNumber.replace(/\//g, '_');
    await db.collection('compare_result').doc(docId).set({
      web_validation_result: parsedResult,
      workflow_status: workflowStatus,
      utility_scrape: utilityRaw,
      meter_validation_result: meterValidation,
      updated_at: new Date()
    }, { merge: true });

    console.log(`[🔥] Web + utility + meter validation saved for ${docId}`);
    return res.json({
      success: true,
      validationResult: parsedResult,
      workflowStatus,
      utilityRaw,
      meterValidation
    });
  } catch (err) {
    console.error('[❌ /api/web-validate Error]', err);
    return res.status(500).json({ message: 'Web validation failed', error: err.message });
  }
});

// Attached Document validation
app.post('/api/validate-document', async (req, res) => {
  try {
    const { extractedData, promptKey = 'default' } = req.body;

    if (!extractedData || typeof extractedData !== 'object') {
      console.error('[Validation] Invalid extractedData:', extractedData);
      return res.status(400).json({ message: 'Invalid extracted data' });
    }

    // === Load Validation Prompt Template ===
    const promptFilePath = path.join(__dirname, 'prompts', 'LOI_Doc_validation.txt');
    if (!fs.existsSync(promptFilePath)) {
      return res.status(400).json({ message: 'Validation prompt file not found.' });
    }
    const promptTemplate = fs.readFileSync(promptFilePath, 'utf8');

    // === 1) Read Master_9_cell.xlsx and determine if Building ID is present ===
    const masterExcelPath = path.join(__dirname, 'prompts', 'Master_9_cell.xlsx');
    let masterData = [];
    let firstColumnHeader = null;
    const buildingId = extractedData['Building ID'];
    req.buildingIdFoundInExcel = false;

    if (fs.existsSync(masterExcelPath)) {
      console.log('[Validation] Found Master_9_cell.xlsx; reading...');
      try {
        const workbook = xlsx.readFile(masterExcelPath);
        const firstSheetName = workbook.SheetNames[0];
        masterData = xlsx.utils.sheet_to_json(workbook.Sheets[firstSheetName]);
        console.log('[Validation] Master_9_cell.xlsx contents (first 5 rows):', masterData.slice(0, 5));

        if (masterData.length > 0) {
          firstColumnHeader = Object.keys(masterData[0])[0];
          console.log('[Validation] Detected first column header (column A):', firstColumnHeader);
        }

        if (buildingId && firstColumnHeader) {
          const found = masterData.some(row => {
            const cellValue = row[firstColumnHeader];
            return (
              cellValue !== undefined &&
              String(cellValue).trim() === String(buildingId).trim()
            );
          });
          req.buildingIdFoundInExcel = found;
          console.log(
            found
              ? `[Validation] Building ID "${buildingId}" FOUND in Master_9_cell.xlsx.`
              : `[Validation] Building ID "${buildingId}" NOT FOUND in Master_9_cell.xlsx.`
          );
        } else {
          if (!buildingId) {
            console.warn('[Validation] extractedData["Building ID"] is missing; skipping Excel lookup.');
          } else {
            console.warn('[Validation] Could not determine first column header; skipping Excel lookup.');
          }
        }
      } catch (excelErr) {
        console.error('[Validation] Error reading Master_9_cell.xlsx:', excelErr);
        req.buildingIdFoundInExcel = false;
      }
    } else {
      console.warn('[Validation] Master_9_cell.xlsx not found; skipping Excel lookup.');
      req.buildingIdFoundInExcel = false;
    }

    // === 2) Extract deposit-related fields and validate deposit ===
    const rawRate = extractedData['Monthly rental rate'];
    const rawDeposit = extractedData['Total Property Deposit'];
    const rawContractNumber = extractedData['Contract number'];
    const tenantSelection = extractedData['Tenant Selection'];

    const parseNumber = str => {
      if (typeof str === 'number') return str;
      if (typeof str !== 'string') return NaN;
      return parseFloat(str.replace(/[^0-9.]/g, '')) || NaN;
    };

    const rate = parseNumber(rawRate);
    const deposit = parseNumber(rawDeposit);
    let depositValid = true;
    let depositReason = '';

    // Helper to ignore decimals
    const roundIgnoreDecimal = num => Math.floor(num);

    const isLO = typeof rawContractNumber === 'string' && rawContractNumber.includes('LO');
    const isTenantNo = String(tenantSelection).trim().toLowerCase() === 'no';
    const buildingFound = Boolean(req.buildingIdFoundInExcel);

    if (isLO && isTenantNo) {
      // Exception 2: LO + Tenant Selection = No → requires 4×
      const expected = roundIgnoreDecimal(rate * 4);
      if (roundIgnoreDecimal(deposit) < expected) {
        depositValid = false;
        depositReason = `Contract Number contains LO and Tenant Selection = No; Total Property Deposit (${deposit}) is less than 4 × Monthly rental rate (${rate} × 4 = ${expected}).`;
      } else {
        depositValid = true;
        depositReason = `Contract Number contains LO and Tenant Selection = No; ${deposit} ≥ 4 × ${rate} (ignoring decimals).`;
      }
      console.log('[Validation] Deposit check (Exception 2):', depositReason);

    } else if (buildingFound) {
      // Exception 1: Building ID found → requires 2×
      const expected = roundIgnoreDecimal(rate * 2);
      if (roundIgnoreDecimal(deposit) < expected) {
        depositValid = false;
        depositReason = `Building ID ${buildingId} found in Master_9_cell.xlsx; Total Property Deposit (${deposit}) is less than 2 × Monthly rental rate (${rate} × 2 = ${expected}).`;
      } else {
        depositValid = true;
        depositReason = `Building ID ${buildingId} found in Master_9_cell.xlsx; ${deposit} ≥ 2 × ${rate} (ignoring decimals).`;
      }
      console.log('[Validation] Deposit check (Exception 1):', depositReason);

    } else {
      // Default rule: requires 3×
      const expected = roundIgnoreDecimal(rate * 3);
      if (roundIgnoreDecimal(deposit) < expected) {
        depositValid = false;
        depositReason = `Total Property Deposit (${deposit}) is less than 3 × Monthly rental rate (${rate} × 3 = ${expected}).`;
      } else {
        depositValid = true;
        depositReason = `Total Property Deposit (${deposit}) ≥ 3 × Monthly rental rate (${rate} × 3 = ${expected}).`;
      }
      console.log('[Validation] Deposit check (Default 3×):', depositReason);
    }

    // Attach the deposit check result
    req.depositValidation = {
      field: 'Total Property Deposit',
      value: rawDeposit,
      valid: depositValid,
      reason: depositReason
    };

    // === 3) Read Master_PT.xlsx and validate Lease property tax rate ===
    const taxExcelPath = path.join(__dirname, 'prompts', 'Master_PT.xlsx');
    let ptData = [];
    let brandList = [];
    const brandNameRaw = extractedData['Brand Name'];
    const rawTaxRate = extractedData['Lease property tax rate'];
    const taxRate = parseNumber(rawTaxRate);
    let taxValid = true;
    let taxReason = '';

    if (fs.existsSync(taxExcelPath)) {
      console.log('[Validation] Found Master_PT.xlsx; reading...');
      try {
        const wbPT = xlsx.readFile(taxExcelPath);
        const ptSheetName = wbPT.SheetNames[0];
        ptData = xlsx.utils.sheet_to_json(wbPT.Sheets[ptSheetName]);
        console.log('[Validation] Master_PT.xlsx contents (first 5 rows):', ptData.slice(0, 5));

        if (ptData.length > 0) {
          const secondColumnHeader = Object.keys(ptData[0])[1];
          console.log('[Validation] Detected second column header (column B):', secondColumnHeader);
          brandList = ptData.map(row => row[secondColumnHeader]).filter(v => v !== undefined && v !== null);
        }

        let foundInPT = false;
        if (brandNameRaw && brandList.length > 0) {
          foundInPT = brandList.some(b =>
            String(b).trim().toLowerCase() === String(brandNameRaw).trim().toLowerCase()
          );
        }

        if (foundInPT) {
          if (taxRate === 0) {
            taxValid = true;
            taxReason = `Brand Name "${brandNameRaw}" found in Master_PT.xlsx; Lease property tax rate (${taxRate}) is zero.`;
          } else {
            taxValid = false;
            taxReason = `Brand Name "${brandNameRaw}" found in Master_PT.xlsx; Lease property tax rate (${taxRate}) must be zero.`;
          }
          console.log('[Validation] Tax check (Brand in PT list):', taxReason);
        } else {
          console.log(
            `[Validation] Brand Name "${brandNameRaw}" NOT FOUND in Master_PT.xlsx; no tax check required.`
          );
          taxValid = true;
          taxReason = `Brand Name "${brandNameRaw}" not found in Master_PT.xlsx; no tax check required.`;
        }
      } catch (ptErr) {
        console.error('[Validation] Error reading Master_PT.xlsx:', ptErr);
        taxValid = true;
        taxReason = 'Error reading Master_PT.xlsx; skipping tax check.';
      }
    } else {
      console.warn('[Validation] Master_PT.xlsx not found; skipping tax lookup.');
      taxValid = true;
      taxReason = 'Master_PT.xlsx not found; skipping tax check.';
    }

    // Attach the tax check result
    req.taxValidation = {
      field: 'Lease property tax rate',
      value: rawTaxRate,
      valid: taxValid,
      reason: taxReason
    };

    // === 4) Build a modified prompt for Gemini that accounts for skips if needed ===
    let modifiedPromptTemplate = promptTemplate;

    // If Building ID not found, tell Gemini to skip deposit check
    if (!req.buildingIdFoundInExcel) {
      console.log(
        `[Validation] Overriding deposit rule because Building ID "${buildingId}" was not found in Master_9_cell.xlsx.`
      );
      modifiedPromptTemplate =
        `NOTE: Building ID "${buildingId}" was NOT found in Master_9_cell.xlsx. Skip the “Total Property Deposit” check entirely.\n\n` +
        promptTemplate;
    } else {
      console.log(
        `[Validation] Leaving deposit rule in place (Building ID "${buildingId}" was found).`
      );
    }

    // If Brand Name not found in PT, tell Gemini to skip tax check
    const brandFoundInPT = !taxReason.includes('not found');
    if (!brandFoundInPT) {
      console.log(
        `[Validation] Overriding tax rule because Brand Name "${brandNameRaw}" was not found in Master_PT.xlsx.`
      );
      modifiedPromptTemplate =
        `NOTE: Brand Name "${brandNameRaw}" was NOT found in Master_PT.xlsx. Skip the “Lease property tax rate” check entirely.\n\n` +
        modifiedPromptTemplate;
    } else {
      console.log(
        `[Validation] Leaving tax rule in place (Brand Name "${brandNameRaw}" was found).`
      );
    }

    // === 5) Final Gemini prompt and send to Gemini ===
    const finalPrompt =
      `${modifiedPromptTemplate}\n\nExtracted Data:\n${JSON.stringify(extractedData, null, 2)}`;

    const geminiRes = await model.generateContent(finalPrompt);
    let geminiText = (await geminiRes.response.text()).trim();

    // === 6) Strip any ```json fences if present ===
    if (geminiText.startsWith('```json')) {
      geminiText = geminiText.slice(7);
    }
    if (geminiText.endsWith('```')) {
      geminiText = geminiText.slice(0, -3);
    }
    geminiText = geminiText.trim();

    // === 7) Return deposit-check, tax-check, and Gemini result ===
    return res.json({
      validation: geminiText,
      depositCheck: req.depositValidation,
      taxCheck: req.taxValidation
    });
  } catch (err) {
    console.error('[Validation Error]', err);
    return res.status(500).json({ message: 'Validation failed', error: err.message });
  }
});

// Function to sanitize JSON and remove null fields or any invalid commas
function sanitizeJson(data) {
  const sanitized = {};
  Object.keys(data).forEach((key) => {
    const value = data[key];
    if (value !== null && value !== undefined) {
      sanitized[key] = value; // Keep valid fields
    } else {
      sanitized[key] = ''; // Set missing or null fields to empty string to avoid invalid JSON
    }
  });
  return sanitized;
}

// End of Attached Document validation

app.post('/api/refresh-contract-status', async (req, res) => {
  const { contractNumber } = req.body;
  if (!contractNumber) {
    return res.status(400).json({ message: 'Missing contractNumber' });
  }
    // ─── DELEGATE TO REMOTE PUPPETEER SERVICE IF CONFIGURED ────────────
    if (process.env.PUPPETEER_SERVICE_URL) {
      console.log('[STEP] delegating refresh-contract-status to remote Puppeteer service');
      try {
        const { data } = await axios.post(
          `${process.env.PUPPETEER_SERVICE_URL}/api/refresh-contract-status`,
          { contractNumber,
            username: process.env.SIMPLICITY_USER,
            password: process.env.SIMPLICITY_PASS
          },
          { timeout: 120000 }
        );
        return res.status(data.success ? 200 : 502).json(data);
      } catch (err) {
        console.error(
          '[ERROR] remote refresh-contract-status failed:',
          err.response?.status,
          err.response?.data || err.message
        );
        return res.status(502).json({
          message: 'Remote refresh-contract-status service error',
          error: err.response?.data || err.message
        });
      }
    }

  try {
    const systemType = 'simplicity';
    let browser, page;

    // ─── 1) LOGIN / SESSION SETUP ─────────────────────────────
    if (browserSessions.has(systemType)) {
      ({ browser, page } = browserSessions.get(systemType));
      console.log('[REFRESH] Reusing existing session');
    } else {
      console.log('[REFRESH] No session — performing login');
    
      const isProd = process.env.NODE_ENV === 'production';
      const launchOptions = {
        headless: isProd,
        defaultViewport: null,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          ...(isProd
            ? [
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--disable-software-rasterizer',
                '--single-process',
                '--disable-dbus-for-chrome'
              ]
            : ['--start-fullscreen']
          )
        ],
        ...(isProd && process.env.PUPPETEER_EXECUTABLE_PATH
          ? { executablePath: process.env.PUPPETEER_EXECUTABLE_PATH }
          : {}
        )
      };
    
      browser = await puppeteer.launch(launchOptions);
      page    = await browser.newPage();

  // …followed by your existing login steps…
  browserSessions.set(systemType, { browser, page });
      console.log('[REFRESH] goto landing page');
      await page.goto('https://mall-management.lotuss.com/Simplicity/apptop.aspx', { waitUntil: 'networkidle2' });

      console.log('[REFRESH] click “go to login”');
      await page.waitForSelector('#lblToLoginPage', { visible: true, timeout: 20000 });
      await Promise.all([
        page.click('#lblToLoginPage'),
        page.waitForNavigation({ waitUntil: 'networkidle2' }).catch(() => {}),
      ]);

      console.log('[REFRESH] enter username');
      await page.waitForSelector('input#username', { visible: true, timeout: 20000 });
      await page.type('input#username', 'john.pattanakarn@lotuss.com', { delay: 50 });
      const cont1 = '#root > div > div > div.sc-dymIpo.izSiFn > div.withConditionalBorder.sc-bnXvFD.izlagV > div.sc-jzgbtB.bIuYUf > form > div > div:nth-child(3) > div > button';
      console.log('[REFRESH] click username Continue');
      await page.waitForSelector(cont1, { visible: true, timeout: 20000 });
      await page.click(cont1);

      console.log('[REFRESH] enter password');
      await page.waitForSelector('input#password', { visible: true, timeout: 20000 });
      await page.type('input#password', 'Gofresh@0425-21', { delay: 50 });
      const cont2 = '#root > div > div > div.sc-dymIpo.izSiFn > div.withConditionalBorder.sc-bnXvFD.izlagV > div.sc-jzgbtB.bIuYUf > form > div > div:nth-child(4) > div > button';
      console.log('[REFRESH] click password Continue');
      await Promise.all([
        page.click(cont2),
        page.waitForNavigation({ waitUntil: 'networkidle2' }).catch(() => {}),
      ]);

      console.log('[REFRESH] login settled');
      await new Promise(r => setTimeout(r, 10000));

      const postLogin = await page.content();
      if (postLogin.includes('Invalid login')) {
        console.error('[REFRESH] Invalid credentials');
        await browser.close();
        return res.status(401).json({ message: 'Invalid credentials' });
      }

      console.log('[REFRESH] login success');
      browserSessions.set(systemType, { browser, page });
    }

    // ─── 2) RELOAD / RESET FRAMEWORK ────────────────────────────
    console.log('[REFRESH] reloading landing page to clear old frames');
    await page.goto('https://mall-management.lotuss.com/Simplicity/apptop.aspx', { waitUntil: 'networkidle2' });
    await new Promise(r => setTimeout(r, 2000));

    // ─── 3) NAVIGATE TO LEASE → SUBMENU ────────────────────────
    console.log('[REFRESH] clicking Lease top menu');
    const leaseTop = '#menu_MenuLiteralDiv > ul > li:nth-child(10) > a';
    await page.waitForSelector(leaseTop, { visible: true, timeout: 15000 });
    await page.click(leaseTop);

    console.log('[REFRESH] hover Lease to expand');
    await page.evaluate(() => {
      const el = [...document.querySelectorAll('a')].find(a => a.textContent.trim() === 'Lease');
      if (el) el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    await new Promise(r => setTimeout(r, 2000));

    const isOffer = contractNumber.includes('LO');
    const submenuText = isOffer ? 'Lease Offer' : 'Lease Renewal';
    console.log(`[REFRESH] clicking submenu "${submenuText}"`);
    const ok = await page.evaluate(text => {
      const link = [...document.querySelectorAll('a')].find(a => a.textContent.trim() === text);
      if (link) { link.click(); return true; }
      return false;
    }, submenuText);
    if (!ok) throw new Error(`Could not click submenu: ${submenuText}`);
    await new Promise(r => setTimeout(r, 5000));

    // ─── 4) RE-ACQUIRE IFRAME & EXTRACT STATUS ─────────────────
    console.log('[REFRESH] waiting for search iframe');
    const iframeHandle = await page.waitForSelector('iframe[name="frameBottom"]', { visible: true, timeout: 20000 });
    const frame = await iframeHandle.contentFrame();
    if (!frame) throw new Error('Could not get contentFrame()');

    console.log('[REFRESH] entering contract number');
    await frame.waitForSelector('#panel_SimpleSearch_c1', { visible: true, timeout: 15000 });
    await frame.evaluate((cn) => {
      const inp = document.querySelector('#panel_SimpleSearch_c1');
      inp.value = cn;
      inp.dispatchEvent(new Event('input', { bubbles: true }));
    }, contractNumber);

    console.log('[REFRESH] clicking search');
    await frame.waitForSelector('a#panel_buttonSearch_bt', { visible: true, timeout: 10000 });
    await frame.click('a#panel_buttonSearch_bt');
    await new Promise(r => setTimeout(r, 5000));

    console.log('[REFRESH] extracting status cell');
    const statusXPath = isOffer
      ? '//*[@id="gridResults_gv"]/tbody/tr[2]/td[13]'
      : '//*[@id="gridResults_gv"]/tbody/tr[2]/td[12]';
    const statusText = await frame.evaluate(xpath => {
      const r = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
      return r.singleNodeValue?.textContent.trim() ?? null;
    }, statusXPath);

    console.log(`[REFRESH] ${contractNumber} → "${statusText}"`);

    // ─── 5) SAVE BACK TO FIRESTORE ─────────────────────────────
    const docId = contractNumber.replace(/\//g, '_');
    await db.collection('compare_result').doc(docId).set({
      workflow_status: statusText,
      updated_at: new Date()
    }, { merge: true });
    console.log(`[REFRESH] workflow_status updated in Firestore for ${docId}`);

    return res.json({ success: true, status: statusText });

  } catch (err) {
    console.error('[REFRESH] Error:', err);
    return res.status(500).json({ message: 'Failed to refresh contract status', error: err.message });
  }
});

app.post('/api/store-validation-result', async (req, res) => {
  const { contractNumber, validationResult } = req.body;
  if (!contractNumber) return res.status(400).json({ message: 'Missing contractNumber' });

  try {
    const docId = contractNumber.replace(/\//g, '_');
    await db.collection('vision_results').doc(docId).set({
      document_validation: validationResult
    }, { merge: true });

    res.json({ success: true, message: 'Validation result saved' });
  } catch (err) {
    console.error('[Firestore Validation Save Error]', err);
    res.status(500).json({ message: 'Failed to save validation result', error: err.message });
  }
});

// === Save comparison and validation result under compare_result ===
app.post('/api/save-compare-result', async (req, res) => {
  const {
    contractNumber,
    compareResult,
    pdfGemini,
    webGemini,
    validationResult,
    popupUrl // ✅ New field added
  } = req.body;

  if (!contractNumber) {
    return res.status(400).json({ message: 'Missing contractNumber' });
  }

  try {
    const docId = contractNumber.replace(/\//g, '_');
    console.log('[Debug] Incoming save payload:', {
      contractNumber,
      compareResult,
      pdfGemini,
      webGemini,
      validationResult,
      popupUrl
    });
    await db.collection('compare_result').doc(docId).set({
      timestamp: new Date(),
      contract_number: contractNumber,
      pdf_extracted: pdfGemini,
      web_extracted: webGemini,
      compare_result: compareResult,
      validation_result: validationResult,
      popup_url: popupUrl || null
    }, { merge: true }); // ✅ ensure i
    console.log('[Firebase Save] Saving popup_url:', popupUrl);
    console.log(`[🔥 compare_result] Document saved: ${docId}`);
    res.json({ success: true, message: 'Comparison and validation result saved' });
  } catch (err) {
    console.error('[Firestore compare_result Save Error]', err);
    res.status(500).json({ message: 'Failed to save compare result', error: err.message });
  }
});

app.post('/api/save-extracted-data', async (req, res) => {
  try {
    const { contractNumber, geminiOutput, pdfData } = req.body;

    if (!contractNumber || !geminiOutput) {
      return res.status(400).json({ message: 'Missing required fields' });
    }

    // Save extracted data to Firebase or your database
    const docId = contractNumber.replace(/\//g, '_');
    await db.collection('extracted_data').doc(docId).set({
      contractNumber,
      geminiOutput,
      pdfData,
      timestamp: new Date(),
    });

    console.log(`[🔥 Firebase] Document saved as ID: ${docId}`);
    res.status(200).json({ success: true, message: 'Data saved successfully' });
  } catch (err) {
    console.error('[❌ Save Extracted Data Error]', err);
    res.status(500).json({ message: 'Error saving extracted data', error: err.message });
  }
});

app.post('/api/save-validation-result', async (req, res) => {
  const { contractNumber, validationResult } = req.body;

  if (!contractNumber || !validationResult) {
    return res.status(400).json({ message: 'Missing contractNumber or validationResult' });
  }

  try {
    const docId = contractNumber.replace(/\//g, '_');

    await db.collection('compare_result').doc(docId).set({
      validation_result: validationResult,
      updated_at: new Date()
    }, { merge: true });

    console.log(`[🔥 compare_result] Validation result saved for: ${docId}`);
    res.json({ success: true, message: 'Validation result saved to compare_result' });
  } catch (err) {
    console.error('[Firestore validation-only save error]', err);
    res.status(500).json({ message: 'Failed to save validation result', error: err.message });
  }
});

app.post('/api/update-lead-status', async (req, res) => {
  const { contractNumber, leadStatus } = req.body;

  if (!contractNumber || !leadStatus) {
    return res.status(400).json({ message: 'Missing contractNumber or leadStatus' });
  }

  try {
    const docId = contractNumber.replace(/\//g, '_');

    await db.collection('compare_result').doc(docId).set({
      lead_status: leadStatus,
      updated_at: new Date(),
    }, { merge: true });

    console.log(`[🔥 Lead Status] Updated lead_status for ${docId} to "${leadStatus}"`);
    res.json({ success: true, message: 'Lead status updated' });
  } catch (err) {
    console.error('[❌ Update Lead Status Error]', err);
    res.status(500).json({ message: 'Failed to update lead status', error: err.message });
  }
});
/*
app.post('/api/web-validate', async (req, res) => {
  try {
    const { contractNumber, extractedData, promptKey = 'default' } = req.body;

    if (!contractNumber || !extractedData || typeof extractedData !== 'object') {
      console.error('[Web Validation] Missing or invalid input:', req.body);
      return res.status(400).json({ message: 'Missing contractNumber or invalid extractedData' });
    }

    // === Load Validation Prompt Template ===
    const promptFilePath = path.join(__dirname, 'prompts', 'LOI_Sim_validation.txt');
    if (!fs.existsSync(promptFilePath)) {
      return res.status(400).json({ message: 'Validation prompt file not found.' });
    }

    const promptTemplate = fs.readFileSync(promptFilePath, 'utf8');
    const finalPrompt = `${promptTemplate}\n\nExtracted Data:\n${JSON.stringify(extractedData, null, 2)}`;

    // === Send to Gemini ===
    const geminiRes = await model.generateContent(finalPrompt);
    const geminiText = await geminiRes.response.text();

    // === Clean Gemini output ===
    let cleaned = geminiText.trim();
    if (cleaned.startsWith('```json')) cleaned = cleaned.slice(7);
    if (cleaned.endsWith('```')) cleaned = cleaned.slice(0, -3);

    let parsedResult;
    try {
      parsedResult = JSON.parse(cleaned);
      if (!Array.isArray(parsedResult)) {
        throw new Error('Expected validation result to be an array');
      }
    } catch (err) {
      console.error('[❌ Web Validation Parsing Error]', err);
      return res.status(500).json({ message: 'Failed to parse Gemini web validation output', raw: geminiText });
    }

    // === Save to Firebase ===
    const docId = contractNumber.replace(/\//g, '_');
    await db.collection('compare_result').doc(docId).set({
      web_validation_result: parsedResult,
      updated_at: new Date()
    }, { merge: true });

    console.log(`[🔥 compare_result] Web validation result saved for: ${docId}`);
    res.json({ success: true, validationResult: parsedResult });
  } catch (err) {
    console.error('[❌ /api/web-validate Error]', err);
    res.status(500).json({ message: 'Web validation failed', error: err.message });
  }
});
*/

app.get('/api/get-compare-results', async (req, res) => {
  try {
    const snapshot = await db.collection('compare_result').orderBy('timestamp', 'desc').limit(100).get();
    
    const data = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));

    res.json({ success: true, data });
  } catch (err) {
    console.error('[🔥 get-compare-results error]', err);
    res.status(500).json({ message: 'Failed to fetch compare results', error: err.message });
  }
});
// Endpoint to check if the file exists in the 'compare_result' collection
app.get('/api/check-file-exists', async (req, res) => {
  try {
    const { filename } = req.query; // Expect filename as query parameter

    if (!filename) {
      return res.status(400).json({ message: 'Filename is required' });
    }

    // Check if the file exists in the 'compare_result' collection
    const snapshot = await db.collection('compare_result')
      .where('contract_number', '==', filename)
      .get();

    if (!snapshot.empty) {
      return res.json({ success: true, message: 'File already processed', exists: true });
    } else {
      return res.json({ success: false, message: 'File not processed yet', exists: false });
    }
  } catch (err) {
    console.error('[❌ Error checking file existence]', err);
    res.status(500).json({ message: 'Error checking file existence', error: err.message });
  }
});

// New endpoint to check if the file exists in Firebase (compare_result collection)
// In your server.js (or wherever your Express routes live):

app.get('/api/check-file-processed', async (req, res) => {
  const { filename } = req.query; // e.g. "5036_LO2502_00060.pdf"

  if (!filename) {
    return res.status(400).json({ message: 'Filename is required' });
  }

  // ── 0) Strip “.pdf” (if present) so our regex can match just the contract number ──
  const baseName = filename.replace(/\.pdf$/i, '');

  // ── 1) Now test: must be digits + "_" + (LO|LR) + digits + "_" + digits ──
  // e.g. "5036_LO2502_00060"
  const validPattern = /^\d+_(?:LO|LR)\d+_\d+$/;
  if (!validPattern.test(baseName)) {
    // Skip anything that does NOT conform. Return processed:true so caller won’t wait.
    return res.json({ success: true, processed: true });
  }

  try {
    // 2) We know baseName matches “5036_LO2502_00060”
    const contractNumber = baseName; // already has no ".pdf"

    // 3) Fetch from Firestore under “compare_result/{contractNumber}”
    const docSnapshot = await db
      .collection('compare_result')
      .doc(contractNumber)
      .get();

    if (!docSnapshot.exists) {
      // no document → not yet processed
      return res.json({ success: true, processed: false });
    }

    // 4) Document exists: grab the three arrays
    const data = docSnapshot.data();
    const compareArr = Array.isArray(data.compare_result) ? data.compare_result : null;
    const webValArr = Array.isArray(data.web_validation_result) ? data.web_validation_result : null;
    const pdfValArr = Array.isArray(data.validation_result) ? data.validation_result : null;

    if (!compareArr || !webValArr || !pdfValArr) {
      // any missing → not fully done
      return res.json({ success: true, processed: false });
    }

    // 5) Check that every row in compare_result has match === true
    const allCompareMatch = compareArr.every(row => row.match === true);
    // 6) Check that every row in web_validation_result has valid === true
    const allWebValid = webValArr.every(row => row.valid === true);
    // 7) Check that every row in validation_result has valid === true
    const allPdfValid = pdfValArr.every(row => row.valid === true);

    const fullyPassed = allCompareMatch && allWebValid && allPdfValid;
    return res.json({ success: true, processed: fullyPassed });
  } catch (error) {
    console.error('[❌ Error in /api/check-file-processed]', error);
    return res.status(500).json({
      message: 'Error checking file processed status',
      error: error.message,
    });
  }
});

app.post('/api/process-sharepoint-folder', async (req, res) => {
  const { folderUrl } = req.body;

  try {
    const files = await fetchFilesFromSharePoint(folderUrl); // Implement this function
    const newContracts = [];

    for (const file of files) {
      const contractNumber = path.basename(file.name, '.pdf');
      const docId = contractNumber.replace(/\//g, '_');

      const docExists = await db.collection('compare_result').doc(docId).get();
      if (docExists.exists) {
        console.log(`✅ Skipping already-processed contract: ${contractNumber}`);
        continue;
      }

      const fileBuffer = await downloadSharePointFile(file.downloadUrl); // implement this

      const tempFilePath = path.join(__dirname, 'uploads', `${contractNumber}.pdf`);
      fs.writeFileSync(tempFilePath, fileBuffer);

      newContracts.push({ contractNumber, tempFilePath });
    }

    res.json({ success: true, contracts: newContracts });
  } catch (err) {
    console.error('[SharePoint Processing Error]', err);
    res.status(500).json({ message: 'Failed to fetch files from SharePoint', error: err.message });
  }
});


import { processOneContract } from './autoProcessor.js';
import axios from 'axios';  // To call the /api/check-file-exists endpoint


app.post('/api/auto-process-pdf-folder', async (req, res) => {
  const FOLDER_PATH = path.join(process.cwd(), 'contracts');
  const files = fs
    .readdirSync(FOLDER_PATH)
    .filter(f => f.toLowerCase().endsWith('.pdf'));
  const promptKey = req.body.promptKey || 'LOI_permanent_fixed_fields';

  // ─── Prepare your date-based output folders ─────────────────────────────
  const now = new Date();
  const dateOnly = now.toISOString().split('T')[0];
  const OUTPUT_BASE = path.join(process.cwd(), 'processed', dateOnly);
  const PASSED_FOLDER  = path.join(OUTPUT_BASE, 'verification_passed');
  const FAILED_FOLDER  = path.join(OUTPUT_BASE, 'verification_failed');
  const SKIPPED_FOLDER = path.join(OUTPUT_BASE, 'skipped');

  for (const dir of [PASSED_FOLDER, FAILED_FOLDER, SKIPPED_FOLDER]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  if (!files.length) {
    return res.status(200).json({ success: false, message: 'No files to process.' });
  }

  let processedCount = 0;

 

  for (const file of files) {
    const baseName = file.replace(/\.pdf$/i, '');
    const validPattern = /^\d+_(?:LO|LR)\d+_\d+$/;

    // 0) Skip invalid names
    if (!validPattern.test(baseName)) {
      console.log(`[⏭️ Skip Invalid Filename] ${file}`);
      continue;
    }

    // 1) Check Firebase
    let alreadyProcessed = false;
    try {
      alreadyProcessed = await checkIfFileExistsInFirebase(baseName);
    } catch (err) {
      console.error(`[❌ ERROR] ${baseName}: checkIfFileExistsInFirebase failed:`, err.message);
      // treat as not processed
      alreadyProcessed = false;
    }

    if (alreadyProcessed) {
      console.log(`[⏭️ Skip Confirmed] ${file} – already processed.`);
      continue;
    }

    // 2) Process it
    console.log(`[📄 Processing] ${file}`);
    const success = await processOneContract(file, promptKey);
    const dest = success ? PASSED_FOLDER : FAILED_FOLDER;

    processedCount++;
    console.log('[⏳] Waiting 90s before next file…');
    await new Promise(r => setTimeout(r, 90_000));
  }

  return res.json({
    success: true,
    processedCount,
    message: `Done — ${processedCount} new file${processedCount !== 1 ? 's' : ''} processed.`
  });
});

// Function to check if the file exists in the Firebase 'compare_result' collection
async function checkIfFileExistsInFirebase(filename) {
  const contractNumber = filename.replace(/\.pdf$/, '');
  const filePath = path.join(FOLDER_PATH, `${contractNumber}.pdf`);
  const docId = contractNumber.replace(/\//g, '_');

  try {
    // ✅ STEP 1: Check if exists in compare_result
    console.log(`[STEP 1] 🔍 Checking if ${docId} exists in compare_result...`);
    const existingDoc = await db.collection('compare_result').doc(docId).get();

    if (existingDoc.exists) {
      console.log(`[✅ STEP 1: Found] ${contractNumber} exists in compare_result.`);

      // ✅ STEP 2: Compare modified timestamp
      console.log(`[STEP 2] 🕒 Comparing modified time for ${contractNumber}...`);
      const fileModifiedTime = fs.statSync(filePath).mtime;
      const BASE_URL = process.env.API_URL || `http://localhost:${PORT}`;
      const timestampRes = await axios.get(
        `${BASE_URL}/api/check-file-timestamp`,
        { params: { filename: contractNumber } }
      );

      const { exists, updatedAt } = timestampRes.data;

      if (exists && updatedAt) {
        const firebaseDate = new Date(updatedAt);
        console.log(`[STEP 2] 🔄 File modified: ${fileModifiedTime.toISOString()} vs Firebase: ${firebaseDate.toISOString()}`);

        if (firebaseDate >= fileModifiedTime) {
          console.log(`[❌ Skipping] Firebase timestamp is newer or equal. ${contractNumber} already processed.`);
          return true;
        } else {
          console.log(`[⚠️ STEP 2: Firebase is older] Proceeding to check contract status.`);
        }
      } else {
        console.log(`[⚠️ STEP 2: No timestamp] Proceeding to check contract status.`);
      }
    } else {
      console.log(`[✅ STEP 1: Not found] ${contractNumber} not yet in compare_result. Skipping timestamp check.`);
    }

  // in your client‐side code (processOneContract, auto‐scrape, etc.)
const serviceUrl =
process.env.NODE_ENV === 'production' && process.env.PUPPETEER_SERVICE_URL
  ? process.env.PUPPETEER_SERVICE_URL
  : 'http://localhost:5001';

console.log(`[STEP 3] 📄 Checking Simplicity status for ${contractNumber}…`);
const statusRes = await axios.post(
`${serviceUrl}/api/check-contract-status`,
{ contractNumber }
);
const contractStatus = statusRes.data?.status || '';
    console.log(`[STEP 3] 🔍 Contract status = "${contractStatus}"`);
    /*
    if (contractStatus.trim() !== 'Pending Verification') {
      console.log(`[🚫 Skipping] ${contractNumber} status is not 'Pending Verification'.`);
      return true;
    }
    */

    console.log(`[✅ PASSED] ${contractNumber} ready for processing.`);
    return false;
  } catch (error) {
    console.error(`[❌ ERROR] ${contractNumber}:`, error.message);
    return false; // Fail-safe: continue processing
  }
}

app.post('/api/update-verified-status', async (req, res) => {
  const { contractNumber, verifiedStatus } = req.body;
  if (!contractNumber || !verifiedStatus) {
    return res.status(400).json({ message: 'Missing fields' });
  }

  try {
    const docId = contractNumber.replace(/\//g, '_');
    await db.collection('compare_result').doc(docId).set(
      { verified_status: verifiedStatus },
      { merge: true }
    );
    console.log(`[Firebase] Set verified_status="${verifiedStatus}" for ${docId}`);
    return res.json({ success: true });
  } catch (err) {
    console.error('[Firestore Error] update-verified-status:', err);
    return res.status(500).json({ message: err.message });
  }
});


// Make sure at the top of server.js you have:
// import dotenv from 'dotenv';
// dotenv.config();

app.post('/api/check-contract-status', async (req, res) => {
  const contractNumber = req.body.contractNumber;
  if (!contractNumber) {
    return res.status(400).json({ message: 'Missing contractNumber' });
  }
  const validPattern = /^\d+_(?:LO|LR)\d+_\d+$/;
  if (!validPattern.test(contractNumber)) {
    return res.json({
      success: true,
      status: null,
      message: 'Skipped: invalid filename format'
    });
  }
  
  if (process.env.PUPPETEER_SERVICE_URL) {
    console.log('[STEP] delegating status check to remote Puppeteer service');
    try {
      const { data } = await axios.post(
        `${process.env.PUPPETEER_SERVICE_URL}/api/check-contract-status`,
        { contractNumber }
      );
      if (!data.success) {
        return res.status(502).json({ success: false, message: 'Remote service failed', ...data });
      }
      return res.json({ success: true, status: data.status });
    } catch (err) {
      console.error('[ERROR] remote status check failed:', err.response?.status, err.response?.data || err.message);
      return res.status(502).json({ success: false, message: 'Remote service error', error: err.response?.data || err.message });
    }
  }
  
  const user = process.env.SIMPLICITY_USER;
  const pass = process.env.SIMPLICITY_PASS;
  if (!user || !pass) {
    console.error('[ERROR] Missing SIMPLICITY_USER or SIMPLICITY_PASS');
    return res.status(500).json({ message: 'Server misconfiguration: missing credentials' });
  }

  // Button selectors
  const continueSel1 = '#root > div > div > div.sc-dymIpo.izSiFn ' +
    '> div.withConditionalBorder.sc-bnXvFD.izlagV ' +
    '> div.sc-jzgbtB.bIuYUf > form > div > div:nth-child(3) > div > button';
  const continueSel2 = '#root > div > div > div.sc-dymIpo.izSiFn ' +
    '> div.withConditionalBorder.sc-bnXvFD.izlagV ' +
    '> div.sc-jzgbtB.bIuYUf > form > div > div:nth-child(4) > div > button';

  try {
    // ─── DELEGATE TO REMOTE SERVICE IF CONFIGURED ─────────────────────────────
    
    if (process.env.PUPPETEER_SERVICE_URL) {
      console.log('[STEP] delegating status check to remote Puppeteer service]');
      const { data } = await axios.post(
        `${process.env.PUPPETEER_SERVICE_URL}/api/check-contract-status`,
        { contractNumber, username: user, password: pass },
        { timeout: 120000 }
      );
      if (!data.success) {
        console.error('[ERROR] remote service failed]', data);
        return res.status(502).json({ success: false, message: 'Remote service failed', ...data });
      }
      return res.json({ success: true, status: data.status });
    }
    

    // ─── Otherwise, run local Puppeteer logic ─────────────────────────────────
    const systemType = 'simplicity';
    // ─── Force a fresh Puppeteer session on every request ─────────
    if (browserSessions.has(systemType)) {
      const { browser, page } = browserSessions.get(systemType);
      await page.close().catch(() => {});
      await browser.close().catch(() => {});
      browserSessions.delete(systemType);
    }
    let browser, page;

    const isLocal = process.env.NODE_ENV !== 'production';
    console.log(`[STEP] Running in ${isLocal ? 'local (headed)' : 'production (headless)'} mode`);

    const launchOptions = {
      headless: !isLocal,
      dumpio: true,
      args: isLocal
        ? ['--start-fullscreen']
        : [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu'
          ],
      ...( !isLocal && process.env.PUPPETEER_EXECUTABLE_PATH
        ? { executablePath: process.env.PUPPETEER_EXECUTABLE_PATH }
        : {}
      )
    };

    if (!browserSessions.has(systemType)) {
      console.log('[STEP] launching new Puppeteer session');
      browser = await puppeteer.launch(launchOptions);
      page    = await browser.newPage();
      const MAX_LOGIN_ATTEMPTS = 3;
      const LOGIN_RETRY_DELAY = 10_000;      // wait 10 s between retries
      const NAV_LOGIN_TIMEOUT  = 120_000;     // give goto up to 60 s
      
      const delay = ms => new Promise(res => setTimeout(res, ms));
      // ─── LOGIN ─────────────────────────────────────────────
      console.log('[STEP] navigating to Simplicity login');
        for (let attempt = 1; attempt <= MAX_LOGIN_ATTEMPTS; attempt++) {
          try {
            console.log(`[STEP] login navigation attempt ${attempt}`);
            await page.goto(
              'https://mall-management.lotuss.com/Simplicity/apptop.aspx',
              { waitUntil: 'networkidle2', timeout: NAV_LOGIN_TIMEOUT }
            );
            break;  // success!
          } catch (err) {
            console.warn(`[STEP] login navigation attempt ${attempt} failed: ${err.message}`);
            if (attempt === MAX_LOGIN_ATTEMPTS) {
              throw new Error(`Login navigation failed after ${MAX_LOGIN_ATTEMPTS} attempts`);
            }
            console.log(`[STEP] retrying login in ${LOGIN_RETRY_DELAY/1000}s…`);
            await delay(LOGIN_RETRY_DELAY);
          }
        }

      console.log('[STEP] clicking “go to login”');
      await page.waitForSelector('#lblToLoginPage', { visible: true, timeout: 180000 });
      await Promise.all([
        page.click('#lblToLoginPage'),
        page.waitForNavigation({ waitUntil: 'networkidle2' })
      ]);

      console.log('[STEP] waiting 5s for username form');
      await new Promise(r => setTimeout(r, 5000));

      console.log('[STEP] typing username');
      await page.waitForSelector('input#username', { visible: true, timeout: 60000 });
      await page.type('input#username', user.toString(), { delay: 50 });

      console.log('[STEP] clicking Continue #1');
      await page.waitForSelector(continueSel1, { visible: true, timeout: 60000 });
      await page.click(continueSel1);

      console.log('[STEP] waiting 5s for password form');
      await new Promise(r => setTimeout(r, 5000));

      console.log('[STEP] typing password');
      await page.waitForSelector('input#password', { visible: true, timeout: 60000 });
      await page.type('input#password', pass.toString(), { delay: 50 });

      console.log('[STEP] clicking Continue #2');
      await page.waitForSelector(continueSel2, { visible: true, timeout: 60000 });
      await Promise.all([
        page.click(continueSel2),
        page.waitForNavigation({ waitUntil: 'networkidle2' })
      ]);

      console.log('[STEP] waiting 15s for post-login settle');
      await new Promise(r => setTimeout(r, 15000));

      const html = await page.content();
      if (html.includes('Invalid login')) {
        console.error('[ERROR] Invalid credentials');
        await browser.close();
        return res.status(401).json({ message: 'Invalid credentials' });
      }
      console.log('[STEP] Simplicity login complete');

      browserSessions.set(systemType, { browser, page });
    } 

    // small buffer
    await new Promise(r => setTimeout(r, 5000));

    // ─── STATUS CHECK ────────────────────────────────────────────────────────
    console.log('[STEP] clicking Lease menu');
    await page.click('#menu_MenuLiteralDiv > ul > li:nth-child(10) > a');
    await new Promise(r => setTimeout(r, 500));

    console.log('[STEP] hovering Lease submenu');
    await page.evaluate(() => {
      const leaseMenu = [...document.querySelectorAll('a')]
        .find(el => el.textContent.trim() === 'Lease');
      leaseMenu?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    await new Promise(r => setTimeout(r, 2000));

    const isLeaseOffer = contractNumber.includes('LO');
    const submenuText  = isLeaseOffer ? 'Lease Offer' : 'Lease Renewal';
    console.log(`[STEP] clicking submenu "${submenuText}"`);
    const clicked = await page.evaluate(text => {
      const link = [...document.querySelectorAll('a')]
        .find(a => a.textContent.trim() === text);
      if (link) { link.click(); return true; }
      return false;
    }, submenuText);
    if (!clicked) throw new Error(`Could not click submenu: ${submenuText}`);
    await new Promise(r => setTimeout(r, 5000));

    console.log('[STEP] waiting for search iframe');
    const iframeHandle = await page.waitForSelector(
      'iframe[name="frameBottom"]',
      { visible: true, timeout: 20000 }
    );
    const frame = await iframeHandle.contentFrame();
    if (!frame) throw new Error('Could not access frameBottom');

    console.log('[STEP] waiting for search box');
    await frame.waitForSelector('#panel_SimpleSearch_c1', { visible: true, timeout: 50000 });

    console.log('[STEP] clearing & typing contract number');
    await frame.evaluate(() => {
      const inp = document.querySelector('#panel_SimpleSearch_c1');
      if (inp) inp.value = '';
    });
    await frame.type('#panel_SimpleSearch_c1', contractNumber, { delay: 50 });

    console.log('[STEP] clicking Search');
    await frame.evaluate(() => document.querySelector('a#panel_buttonSearch_bt')?.click());
    await new Promise(r => setTimeout(r, 5000));

    console.log('[STEP] extracting status cell');
    const statusXPath = isLeaseOffer
      ? '//*[@id="gridResults_gv"]/tbody/tr[2]/td[13]'
      : '//*[@id="gridResults_gv"]/tbody/tr[2]/td[12]';
    const statusText = await frame.evaluate(xpath => {
      const r = document.evaluate(
        xpath, document, null,
        XPathResult.FIRST_ORDERED_NODE_TYPE, null
      );
      return r.singleNodeValue?.textContent.trim() || null;
    }, statusXPath);

    console.log(`[RESULT] ${contractNumber} → "${statusText}"`);
    return res.json({ success: true, status: statusText });

  } catch (err) {
    console.error('[ERROR] Contract status check failed:', err);
    return res.status(500).json({
      message: 'Failed to check contract status',
      error: err.message
    });
  }
});

// The /api/check-file-exists endpoint in your server (if not added already)
app.get('/api/check-file-exists', async (req, res) => {
  try {
    const { filename } = req.query; // Expect filename as query parameter

    if (!filename) {
      return res.status(400).json({ message: 'Filename is required' });
    }

    // Check if the file exists in the 'compare_result' collection
    const snapshot = await db.collection('compare_result')
      .where('contract_number', '==', filename)  // Use the contract number without .pdf
      .get();

    if (!snapshot.empty) {
      return res.json({ success: true, message: 'File already processed', exists: true });
    } else {
      return res.json({ success: false, message: 'File not processed yet', exists: false });
    }
  } catch (err) {
    console.error('[❌ Error checking file existence]', err);
    res.status(500).json({ message: 'Error checking file existence', error: err.message });
  }
});

app.get('/api/check-file-timestamp', async (req, res) => {
  try {
    const { filename } = req.query;

    if (!filename) {
      return res.status(400).json({ message: 'Filename (contract number) is required' });
    }

    // Query Firestore for the document with the matching contract number
    const snapshot = await db.collection('compare_result')
      .where('contract_number', '==', filename)
      .limit(1)
      .get();

    if (snapshot.empty) {
      return res.status(200).json({
        success: false,
        exists: false,
        message: 'No matching document found'
      });
    }

    const doc = snapshot.docs[0].data();

    const updatedAt = doc.updated_at?.seconds
      ? new Date(doc.updated_at.seconds * 1000)
      : (doc.updated_at ? new Date(doc.updated_at) : null);

    if (!updatedAt) {
      return res.status(200).json({
        success: true,
        exists: true,
        updatedAt: null,
        message: 'Document found, but no updated_at field'
      });
    }

    return res.status(200).json({
      success: true,
      exists: true,
      updatedAt: updatedAt.toISOString(),
      message: 'Timestamp fetched successfully'
    });
  } catch (err) {
    console.error('[❌ Error in /api/check-file-timestamp]', err);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: err.message
    });
  }
});


app.post('/api/update-workflow-status', async (req, res) => {
  const { contractNumber, workflowStatus } = req.body;
  if (!contractNumber || !workflowStatus) {
    return res.status(400).json({ success: false, message: 'Missing contractNumber or workflowStatus' });
  }

  try {
    const docId = contractNumber.replace(/\//g, '_');
    await db.collection('compare_result').doc(docId).set(
      { workflow_status: workflowStatus },
      { merge: true }
    );
    console.log(`[✅ Firestore] workflow_status for ${docId} set to "${workflowStatus}"`);
    return res.json({ success: true });
  } catch (err) {
    console.error(`[❌ Failed to update workflow_status for ${contractNumber}]:`, err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// at the bottom of server.js, before `app.listen(...)`
app.get('/api/health', (req, res) => {
  res.json({ uptime: process.uptime(), env: process.env.NODE_ENV });
});



app.post('/api/contract-classify', async (req, res) => {
  try {
    const { ocrText } = req.body;
    if (!ocrText) return res.status(400).json({ error: 'Missing OCR text' });

    const classifyPromptPath = path.join(__dirname, 'prompts', 'LOI_classify_prompt.txt');
    const promptTemplate = fs.readFileSync(classifyPromptPath, 'utf-8');

    const fullPrompt = `${promptTemplate.trim()}\n\n${ocrText.trim()}`;

    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

    const result = await model.generateContent(fullPrompt);
    const text = result.response.text();

    // Clean and parse
    let raw = text.trim();
    if (raw.startsWith('```json')) raw = raw.slice(7);
    if (raw.endsWith('```')) raw = raw.slice(0, -3);

    const jsonBlock = raw.substring(raw.indexOf('{'), raw.lastIndexOf('}') + 1);
    const parsed = JSON.parse(jsonBlock);

    const contractType = parsed?.['Contract Type']?.trim();
    if (!contractType) throw new Error('No Contract Type found in Gemini output');

    res.json({ contractType });
  } catch (err) {
    console.error('[❌ Contract Classification Error]', err);
    res.status(500).json({ error: err.message });
  }
});


app.post('/api/scrape-url-test', async (req, res) => {
  console.log('→ SIMPLICITY_USER=', process.env.SIMPLICITY_USER);
console.log('→ SIMPLICITY_PASS=', process.env.SIMPLICITY_PASS && '*****');
  const { systemType, username, password, contractNumber } = req.body;
  // fallback if promptKey is missing or empty
  const promptKey = (req.body.promptKey && req.body.promptKey.trim())
    ? req.body.promptKey.trim()
    : 'LOI_permanent_fixed_fields';

  if (!systemType || systemType === 'others') {
    return res.status(400).json({ success: false, message: 'Invalid systemType' });
  }
  if (!username || !password || !contractNumber) {
    return res.status(400).json({ success: false, message: 'username, password & contractNumber required' });
  }

  try {
    // --- LOGIN STEP ---
    let browser, page;
    if (browserSessions.has(systemType)) {
      ({ browser, page } = browserSessions.get(systemType));
    } else {
      const isProd = process.env.NODE_ENV === 'production';
      const launchOpts = {
        headless: isProd,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          ...(isProd ? ['--disable-dev-shm-usage', '--disable-gpu'] : [])
        ],
        ...(isProd && {
          executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/google-chrome'
        })
      };

      browser = await puppeteer.launch(launchOpts);
      page    = await browser.newPage();
      await page.goto('https://mall-management.lotuss.com/Simplicity/apptop.aspx', { waitUntil: 'networkidle2' });

      await page.waitForSelector('#lblToLoginPage', { timeout: 60000 });
      await page.click('#lblToLoginPage');

      await page.waitForSelector('input#username', { timeout: 60000 });
      await page.type('input#username', username, { delay: 50 });
      const continueSel1 = '#root > div > div > div.sc-dymIpo.izSiFn > div.withConditionalBorder.sc-bnXvFD.izlagV > div.sc-jzgbtB.bIuYUf > form > div > div:nth-child(3) > div > button';
      await page.waitForSelector(continueSel1, { timeout: 20000 });
      await page.click(continueSel1);

      await page.waitForSelector('input#password', { timeout: 60000 });
      await page.type('input#password', password, { delay: 50 });
      const continueSel2 = '#root > div > div > div.sc-dymIpo.izSiFn > div.withConditionalBorder.sc-bnXvFD.izlagV > div.sc-jzgbtB.bIuYUf > form > div > div:nth-child(4) > div > button';
      await page.waitForSelector(continueSel2, { timeout: 60000 });
      await page.click(continueSel2);

      await page.waitForNavigation({ waitUntil: 'networkidle2' }).catch(() => {});
      await new Promise(r => setTimeout(r, 10000));

      const html = await page.content();
      if (html.includes('Invalid login')) {
        await browser.close();
        return res.status(401).json({ success: false, message: 'Invalid credentials' });
      }
      browserSessions.set(systemType, { browser, page });
    }

    // --- SCRAPE STEP ---
    await page.waitForSelector('#menu_MenuLiteralDiv > ul > li:nth-child(10) > a', { timeout: 60000 });
    await page.click('#menu_MenuLiteralDiv > ul > li:nth-child(10) > a');
    await new Promise(r => setTimeout(r, 500));
    await page.evaluate(() => {
      const leaseMenu = [...document.querySelectorAll('a')].find(el => el.textContent.trim() === 'Lease');
      leaseMenu?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    await new Promise(r => setTimeout(r, 2000));

    const isOffer = contractNumber.includes('LO');
    const submenuText = isOffer ? 'Lease Offer' : 'Lease Renewal';
    const submenuClicked = await page.evaluate(text => {
      const links = [...document.querySelectorAll('a')];
      const target = links.find(el => el.textContent.trim() === text);
      if (target) { target.click(); return true; }
      return false;
    }, submenuText);
    if (!submenuClicked) throw new Error(`❌ Could not click ${submenuText}`);
    await new Promise(r => setTimeout(r, 10000));

    await page.waitForSelector('iframe[name="frameBottom"]', { timeout: 70000 });
    const iframeHandle = await page.$('iframe[name="frameBottom"]');
    const frame = await iframeHandle.contentFrame();
    if (!frame) throw new Error('❌ Could not access iframe content');

    await frame.waitForSelector('#panel_SimpleSearch_c1', { visible: true, timeout: 70000 });
    await frame.evaluate(cn => {
      const input = document.querySelector('#panel_SimpleSearch_c1');
      input.value = cn;
      input.focus();
    }, contractNumber);

    await frame.waitForSelector('a#panel_buttonSearch_bt', { visible: true, timeout: 60000 });
    await frame.evaluate(() => document.querySelector('a#panel_buttonSearch_bt')?.click());
    await new Promise(r => setTimeout(r, 15000));

    const viewButton = await frame.$('input[src*="view-black-16.png"]');
    if (!viewButton) throw new Error('❌ View icon not found');
    await viewButton.click();

    const popupUrlMatch = isOffer ? 'leaseoffer/edit.aspx' : 'leaserenewal/edit.aspx';
    let popup;
    for (let i = 0; i < 15; i++) {
      const pages = await browser.pages();
      popup = pages.find(p => p.url().includes(popupUrlMatch) && p !== page);
      if (popup) break;
      await new Promise(r => setTimeout(r, 2000));
    }
    if (!popup) throw new Error('❌ Popup window not found');
    await popup.bringToFront();

    const panels = [
      '#panelMonthlyCharge_label',
      '#panelOtherMonthlyCharge_label',
      '#panelGTO_label',
      '#LeaseMeterTypessArea_label',
      '#panelSecurityDeposit_label',
      '#panelOneTimeCharge_label'
    ];
    await new Promise(r => setTimeout(r, 10000));
    for (const sel of panels) {
      try {
        const collapsed = await popup.$eval(sel, el => el.classList.contains('collapsible-panel-collapsed'));
        if (collapsed) await popup.click(sel);
      } catch {}
      await new Promise(r => setTimeout(r, 2000));
    }

    const raw = await popup.evaluate(() => document.body.innerText);
    const promptFile = path.join(__dirname, 'prompts', `${promptKey}.txt`);
    if (!fs.existsSync(promptFile)) throw new Error(`Prompt ${promptKey} not found`);
    const template = fs.readFileSync(promptFile, 'utf8');
    const gemRes = await model.generateContent(`${template}\n\nContent:\n${raw}`);
    const gemText = await gemRes.response.text();

    const docId = contractNumber.replace(/\//g, '_');
    await db.collection('compare_result').doc(docId).set({
      timestamp: new Date(),
      contract_number: docId,
      web_extracted: raw,
      gemini_output: gemText,
      popup_url: popup.url()
    }, { merge: true });

    return res.json({ success: true, raw, geminiOutput: gemText, popupUrl: popup.url() });
  } catch (err) {
    console.error('[SCRAPE-URL-TEST Error]', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

async function refreshAllVerifiedStatus() {
  console.log('[⟳] Starting to recompute verified_status for all compare_result documents…');

  try {
    // 1) Grab every document in the "compare_result" collection
    const snapshot = await db.collection('compare_result').get();

    if (snapshot.empty) {
      console.log('[⟳] No documents found in compare_result; nothing to update.');
      return;
    }

    // 2) Loop through each doc, compute “Passed” vs “Needs Review”, then write
    const batch = db.batch(); // use a batch write in case you have many docs

    snapshot.docs.forEach((docSnap) => {
      const data = docSnap.data();
      const docRef = docSnap.ref;
      const docId = docSnap.id; // e.g. "ABC123"

      // a) Pull out compare_result array and validation_result array
      //    * You can also include web_validation_result if desired, but up to you.
      const compareArr = Array.isArray(data.compare_result) ? data.compare_result : [];
      const pdfValArr = Array.isArray(data.validation_result) ? data.validation_result : [];
      const webValArr = Array.isArray(data.web_validation_result)
        ? data.web_validation_result
        : [];

      // b) Compute “all match = true?” and “all valid = true?”
      const allCompareMatch = compareArr.length > 0 && compareArr.every((row) => row.match === true);
      const allPdfValid = pdfValArr.length > 0 && pdfValArr.every((row) => row.valid === true);
      const allWebValid = webValArr.length > 0 && webValArr.every((row) => row.valid === true);

      // c) Decide final “verified” status rule:
      //    Here we’ll say “Passed” only if all three arrays exist AND every row is true.
      //    If any array is missing or any row fails, we call it “Needs Review.”
      let finalStatus = 'Needs Review';
      if (allCompareMatch && allPdfValid && allWebValid) {
        finalStatus = 'Passed';
      }

      // d) Schedule a merge‐write updating “verified_status”
      batch.set(docRef, { verified_status: finalStatus }, { merge: true });
      console.log(`   • Doc ${docId}: compare(${allCompareMatch}), pdf(${allPdfValid}), web(${allWebValid}) → "${finalStatus}"`);
    });

    // 3) Commit in one batch (or split into multiple if > 500 writes)
    await batch.commit();
    console.log('[✅] All verified_status fields updated successfully.');
  } catch (err) {
    console.error('[❌] Error in refreshAllVerifiedStatus():', err);
  }
}

// ===== Server Start =====
const PORT = process.env.PORT || 5001;
app.listen(PORT, () => console.log(`Server is running on port ${PORT}`));
